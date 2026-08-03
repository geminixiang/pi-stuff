function createReviewWorkspace(initialState) {
	function setServerOnline(online) {
		document.getElementById("server-icon").href = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="' + (online ? "#22c55e" : "#ef4444") + '"/></svg>');
		const dot = document.querySelector(".server-dot");
		dot?.classList.toggle("off", !online);
		if (dot) dot.title = dot.ariaLabel = online ? "Diff server connected" : "Diff server disconnected";
	}
	const events = new EventSource("/events");
	events.onopen = () => setServerOnline(true);
	events.onmessage = () => refresh();
	events.onerror = () => setServerOnline(false);

	(() => {
		const toggle = document.querySelector(".menu-toggle");
		const scrim = document.querySelector(".scrim");
		const close = () => document.body.classList.remove("menu-open");
		toggle?.addEventListener("click", () => document.body.classList.toggle("menu-open"));
		scrim?.addEventListener("click", close);
		document.querySelector(".sidebar")?.addEventListener("click", (event) => {
			if (event.target.closest("a, .file")) close();
		});
		addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
	})();

	let diff = initialState.diff;
	let files = initialState.files;
	let signatures = initialState.signatures;
	const reviewMode = initialState.reviewMode;
	const emptyMessage = initialState.emptyMessage;
	const defaultHint = "Select code or drag line numbers to comment";
	const reviewStorageKey = "pi-diff-review:" + location.pathname;
	let comments = [];
	let editorState = null;
	let pendingRefresh = false;
	let refreshing = false;
	let viewed = initialState.viewed;
	let latestCommits = initialState.commits || [];
	viewed = Object.fromEntries(files.filter((path) => viewed[path] === signatures[path]).map((path) => [path, viewed[path]]));
	function isViewed(path) {
		return viewed[path] === signatures[path];
	}
	function saveViewed(path, signature, checked) {
		checked ? viewed[path] = signature : delete viewed[path];
		const body = JSON.stringify({ currentPath: location.pathname, path, signature, checked });
		fetch("/viewed", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
		renderSidebar(latestCommits);
	}
	function setDiffViewed(wrapper, checked) {
		wrapper.querySelector(".d2h-file-collapse")?.classList.toggle("d2h-selected", checked);
		wrapper.querySelector(".d2h-file-diff, .d2h-files-diff")?.classList.toggle("d2h-d-none", checked);
	}
	function syncDiffViewed() {
		document.querySelectorAll(".d2h-file-wrapper").forEach((wrapper) => setDiffViewed(wrapper, isViewed(wrapper.dataset.path)));
	}
	document.addEventListener("change", (event) => {
		const checkbox = event.target.closest?.(".d2h-file-collapse-input");
		if (!checkbox) return;
		saveViewed(checkbox.dataset.path, checkbox.dataset.signature, checkbox.checked);
		setTimeout(syncDiffViewed, 0);
	});
	let outputFormat = matchMedia("(max-width: 900px)").matches ? "line-by-line" : "side-by-side";
	const container = document.getElementById("diff");
	const modeButtons = document.querySelectorAll(".view-mode");

	function updateModeButtons() {
		modeButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.mode === outputFormat));
	}

	function setActive(index) {
		document.querySelectorAll(".file").forEach((item) => item.classList.toggle("active", item.dataset.index === String(index)));
	}

	const headerH = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 42;
	const observer = new IntersectionObserver((entries) => {
		const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
		if (visible) setActive(visible.target.id.replace("file-", ""));
	}, { rootMargin: "-" + headerH + "px 0px -60% 0px" });

	function assignFileAnchors() {
		observer.disconnect();
		document.querySelectorAll(".d2h-file-wrapper").forEach((wrapper, index) => {
			const path = files[index];
			wrapper.id = "file-" + index;
			wrapper.dataset.path = path;
			const checkbox = wrapper.querySelector(".d2h-file-collapse-input");
			if (checkbox) {
				checkbox.dataset.path = path;
				checkbox.dataset.signature = signatures[path] || "";
				checkbox.checked = isViewed(path);
			}
			setDiffViewed(wrapper, isViewed(path));
			observer.observe(wrapper);
		});
	}

	function wireFileListCollapse() {
		const fileList = document.querySelector(".d2h-file-list-wrapper");
		if (!fileList) return;
		new ResizeObserver(([entry]) => document.documentElement.style.setProperty("--file-list-h", (entry.borderBoxSize?.[0]?.blockSize || fileList.offsetHeight) + "px")).observe(fileList);
		fileList.addEventListener("click", (event) => {
			if (event.target.closest(".d2h-file-list, .d2h-file-switch")) return;
			const show = fileList.querySelector(".d2h-show");
			fileList.querySelector(show?.style.display === "none" ? ".d2h-hide" : ".d2h-show")?.click();
		});
	}

	const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
	const wrapperFor = (path) => Array.from(document.querySelectorAll(".d2h-file-wrapper")).find((wrapper) => wrapper.dataset.path === path);
	const reviewRows = (wrapper, side) => Array.from(wrapper.querySelectorAll("tr.review-line")).filter((row) => row.dataset.reviewSide === side);
	const sideRangeLabel = (side, line, endLine) => (side === "old" ? "Old" : "New") + (endLine === line ? " line " + line : " lines " + line + "–" + endLine);
	const rangeLabel = (item) => (item.oldLine
		? sideRangeLabel("old", item.oldLine, item.oldEndLine) + " · " + sideRangeLabel("new", item.line, item.endLine)
		: sideRangeLabel(item.side, item.line, item.endLine));

	function persistDrafts() {
		if (!reviewMode) return;
		try { sessionStorage.setItem(reviewStorageKey, JSON.stringify({ comments, draft: editorState })); } catch {}
	}

	function restoreDrafts() {
		if (!reviewMode) return;
		try {
			const saved = JSON.parse(sessionStorage.getItem(reviewStorageKey) || "null");
			if (Array.isArray(saved?.comments)) comments = saved.comments.filter((comment) => comment && typeof comment.path === "string" && typeof comment.body === "string" && comment.body.trim());
			if (saved?.draft && typeof saved.draft.path === "string") editorState = { ...saved.draft, restored: true };
		} catch {}
	}

	function insertReviewRow(anchorRow, row) {
		anchorRow.after(row);
		const pane = anchorRow.closest(".d2h-file-side-diff");
		const panes = pane ? Array.from(pane.closest(".d2h-files-diff").querySelectorAll(":scope > .d2h-file-side-diff")) : [];
		const twinBody = panes.length === 2 ? panes[pane === panes[0] ? 1 : 0].querySelector("tbody") : null;
		const twin = twinBody?.children[Array.prototype.indexOf.call(anchorRow.parentElement.children, anchorRow)];
		if (!twin) return;
		const spacer = document.createElement("tr");
		spacer.className = "review-spacer-row";
		const pad = document.createElement("td");
		pad.colSpan = 2;
		spacer.appendChild(pad);
		twin.after(spacer);
		const sync = () => { pad.style.height = row.getBoundingClientRect().height + "px"; };
		new ResizeObserver(sync).observe(row.firstElementChild);
		sync();
	}

	function buildCommentRow(comment) {
		const row = document.createElement("tr");
		row.className = "review-comment-row";
		const cell = document.createElement("td");
		cell.colSpan = 2;
		row.appendChild(cell);
		const box = document.createElement("div");
		box.className = "review-comment";
		const main = document.createElement("div");
		main.className = "review-comment-main";
		const meta = document.createElement("div");
		meta.className = "review-comment-meta";
		const label = document.createElement("span");
		label.textContent = rangeLabel(comment);
		meta.appendChild(label);
		if (signatures[comment.path] !== comment.signature) {
			const stale = document.createElement("span");
			stale.className = "review-stale";
			stale.textContent = "file changed since this comment";
			meta.appendChild(stale);
		}
		const body = document.createElement("div");
		body.className = "review-comment-body";
		body.textContent = comment.body;
		main.append(meta, body);
		const actions = document.createElement("div");
		actions.className = "review-comment-actions";
		const edit = document.createElement("button");
		edit.type = "button";
		edit.textContent = "Edit";
		edit.onclick = () => {
			editorState = { editingId: comment.id, path: comment.path, signature: comment.signature, side: comment.side, line: comment.line, endLine: comment.endLine, oldLine: comment.oldLine, oldEndLine: comment.oldEndLine, excerpt: comment.excerpt, body: comment.body };
			renderComments({ focusEditor: true });
		};
		const remove = document.createElement("button");
		remove.type = "button";
		remove.textContent = "Remove";
		remove.onclick = () => {
			comments = comments.filter((item) => item !== comment);
			renderComments();
		};
		actions.append(edit, remove);
		box.append(main, actions);
		cell.appendChild(box);
		return row;
	}

	function buildEditorRow(state) {
		const row = document.createElement("tr");
		row.className = "review-comment-row review-editor-row";
		const cell = document.createElement("td");
		cell.colSpan = 2;
		row.appendChild(cell);
		cell.innerHTML = '<div class="review-editor"><span class="review-editor-label"></span><textarea placeholder="Leave a comment for the agent…"></textarea><div class="review-editor-actions"><button class="review-cancel" type="button" title="Esc">Cancel</button><button class="review-add" type="button"></button></div></div>';
		cell.querySelector(".review-editor-label").textContent = rangeLabel(state);
		const textarea = cell.querySelector("textarea");
		textarea.value = state.body || "";
		const add = cell.querySelector(".review-add");
		add.textContent = state.editingId ? "Save" : "Add comment";
		add.title = navigator.platform.includes("Mac") ? "⌘⏎" : "Ctrl+Enter";
		const closeEditor = () => {
			editorState = null;
			renderComments();
			if (pendingRefresh) { pendingRefresh = false; refresh(); }
		};
		const commit = () => {
			const body = textarea.value.trim();
			if (!body) return textarea.focus();
			if (state.editingId) {
				const existing = comments.find((item) => item.id === state.editingId);
				if (existing) existing.body = body;
			} else {
				comments.push({ id: uid(), path: state.path, signature: state.signature, side: state.side, line: state.line, endLine: state.endLine, oldLine: state.oldLine, oldEndLine: state.oldEndLine, excerpt: state.excerpt, body });
			}
			closeEditor();
		};
		textarea.addEventListener("input", () => { state.body = textarea.value; persistDrafts(); });
		textarea.addEventListener("keydown", (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); commit(); }
			else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeEditor(); }
		});
		textarea.addEventListener("blur", () => {
			if (pendingRefresh && !textarea.value.trim()) { pendingRefresh = false; refresh(); }
		});
		cell.querySelector(".review-cancel").onclick = closeEditor;
		add.onclick = commit;
		return row;
	}

	function markOldRange(wrapper, item, className) {
		if (!item.oldLine) return;
		reviewRows(wrapper, "old")
			.filter((row) => Number(row.dataset.reviewLine) >= item.oldLine && Number(row.dataset.reviewLine) <= item.oldEndLine)
			.forEach((row) => row.classList.add(className));
	}

	function attachCommentRow(comment) {
		const wrapper = wrapperFor(comment.path);
		if (!wrapper) return false;
		const rows = reviewRows(wrapper, comment.side);
		if (!rows.length) return false;
		const selected = rows.filter((row) => Number(row.dataset.reviewLine) >= comment.line && Number(row.dataset.reviewLine) <= comment.endLine);
		selected.forEach((row) => row.classList.add("review-commented"));
		markOldRange(wrapper, comment, "review-commented");
		const anchor = selected[selected.length - 1] || rows.filter((row) => Number(row.dataset.reviewLine) < comment.line).pop() || rows[0];
		insertReviewRow(anchor, buildCommentRow(comment));
		return true;
	}

	function attachEditorRow(state, focusEditor) {
		const wrapper = wrapperFor(state.path);
		const rows = wrapper ? reviewRows(wrapper, state.side) : [];
		if (!rows.length) return false;
		const selected = rows.filter((row) => Number(row.dataset.reviewLine) >= state.line && Number(row.dataset.reviewLine) <= state.endLine);
		selected.forEach((row) => row.classList.add("review-selected"));
		markOldRange(wrapper, state, "review-selected");
		const anchor = selected[selected.length - 1] || rows.filter((row) => Number(row.dataset.reviewLine) < state.line).pop() || rows[0];
		const row = buildEditorRow(state);
		insertReviewRow(anchor, row);
		const textarea = row.querySelector("textarea");
		if (state.restored) {
			delete state.restored;
			row.scrollIntoView({ block: "center" });
			focusEditor = true;
		}
		if (focusEditor) {
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		}
		return true;
	}

	function renderOrphans(orphans) {
		if (!orphans.length) return;
		const box = document.createElement("div");
		box.className = "review-orphans";
		const title = document.createElement("div");
		title.className = "review-orphans-title";
		title.textContent = "Comments on lines no longer in the diff — still included in the review:";
		box.appendChild(title);
		for (const comment of orphans) {
			const item = document.createElement("div");
			item.className = "review-orphan";
			const text = document.createElement("span");
			text.textContent = comment.path + " · " + rangeLabel(comment) + " — " + comment.body;
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "Remove";
			remove.onclick = () => {
				comments = comments.filter((entry) => entry !== comment);
				renderComments();
			};
			item.append(text, remove);
			box.appendChild(item);
		}
		container.prepend(box);
	}

	function renderComments(options = {}) {
		if (!reviewMode) return;
		document.querySelectorAll(".review-comment-row, .review-spacer-row, .review-orphans").forEach((node) => node.remove());
		document.querySelectorAll(".review-commented, .review-selected").forEach((row) => row.classList.remove("review-commented", "review-selected"));
		const orphans = [];
		for (const comment of comments) {
			if (editorState && editorState.editingId === comment.id) continue;
			if (!attachCommentRow(comment)) orphans.push(comment);
		}
		if (editorState && !attachEditorRow(editorState, options.focusEditor)) {
			const state = editorState;
			editorState = null;
			if (!state.editingId && state.body && state.body.trim()) {
				comments.push({ id: uid(), path: state.path, signature: state.signature, side: state.side, line: state.line, endLine: state.endLine, excerpt: state.excerpt, body: state.body.trim() });
			}
			return renderComments(options);
		}
		renderOrphans(orphans);
		updateReviewBar();
		renderSidebar(latestCommits);
		persistDrafts();
	}

	function wireReviewLines() {
		document.querySelectorAll(".d2h-file-wrapper").forEach((wrapper) => {
			const rows = [];
			wrapper.querySelectorAll("tr").forEach((row) => {
				const numberCell = row.querySelector(".d2h-code-linenumber, .d2h-code-side-linenumber");
				if (!numberCell || numberCell.classList.contains("d2h-info") || numberCell.classList.contains("d2h-emptyplaceholder")) return;
				let side; let line;
				if (numberCell.classList.contains("d2h-code-side-linenumber")) {
					const panes = Array.from(wrapper.querySelectorAll(":scope > .d2h-files-diff > .d2h-file-side-diff"));
					side = panes.indexOf(numberCell.closest(".d2h-file-side-diff")) === 0 ? "old" : "new";
					line = Number(numberCell.textContent.trim());
				} else {
					const oldLine = numberCell.querySelector(".line-num1")?.textContent.trim();
					const newLine = numberCell.querySelector(".line-num2")?.textContent.trim();
					side = newLine ? "new" : "old";
					line = Number(newLine || oldLine);
				}
				if (!line) return;
				row.dataset.reviewSide = side;
				row.dataset.reviewLine = String(line);
				row.classList.add("review-line");
				numberCell.title = "Comment on this line — drag for a range";
				rows.push(row);
			});

			let selection = null;
			const sameSideRows = (startRow) => rows.filter((row) => row.dataset.reviewSide === startRow.dataset.reviewSide);
			const paintSelection = (startRow, endRow) => {
				const candidates = sameSideRows(startRow);
				const start = candidates.indexOf(startRow);
				const end = candidates.indexOf(endRow);
				if (end < 0) return;
				const low = Math.min(start, end);
				const high = Math.max(start, end);
				rows.forEach((row) => row.classList.toggle("review-selected", candidates.indexOf(row) >= low && candidates.indexOf(row) <= high));
				selection.endRow = endRow;
			};
			const clearSelection = () => {
				selection = null;
				document.body.classList.remove("review-selecting");
				rows.forEach((row) => row.classList.remove("review-selected"));
			};
			wrapper.addEventListener("pointerdown", (event) => {
				const numberCell = event.target.closest(".d2h-code-linenumber, .d2h-code-side-linenumber");
				const row = numberCell?.closest("tr.review-line");
				if (!row) return;
				event.preventDefault();
				const openTextarea = document.querySelector(".review-editor textarea");
				if (openTextarea) return openTextarea.focus();
				selection = { startRow: row, endRow: row };
				document.body.classList.add("review-selecting");
				paintSelection(row, row);
				numberCell.setPointerCapture?.(event.pointerId);
			});
			wrapper.addEventListener("pointermove", (event) => {
				if (!selection) return;
				const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("tr.review-line");
				if (target && target.closest(".d2h-file-wrapper") === wrapper) paintSelection(selection.startRow, target);
			});
			wrapper.addEventListener("pointerup", () => {
				if (!selection) return;
				const { startRow, endRow } = selection;
				clearSelection();
				openEditorFromRows(wrapper, startRow, endRow);
			});
			wrapper.addEventListener("pointercancel", clearSelection);
		});
	}

	function openEditorAt(path, side, line, endLine, excerpt, oldRange) {
		const openTextarea = document.querySelector(".review-editor textarea");
		if (openTextarea) return openTextarea.focus();
		editorState = { path, signature: signatures[path] || "", side, line, endLine, oldLine: oldRange?.line, oldEndLine: oldRange?.endLine, excerpt, body: "" };
		renderComments({ focusEditor: true });
	}

	function openEditorFromRows(wrapper, startRow, endRow) {
		const rows = reviewRows(wrapper, startRow.dataset.reviewSide);
		const startIndex = rows.indexOf(startRow);
		const endIndex = rows.indexOf(endRow);
		if (startIndex < 0 || endIndex < 0) return;
		const selected = rows.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1);
		const first = selected[0];
		const last = selected[selected.length - 1];
		const excerpt = normalizeExcerpt(first.querySelector(".d2h-code-line-ctn")?.textContent || "");
		openEditorAt(wrapper.dataset.path, first.dataset.reviewSide, Number(first.dataset.reviewLine), Number(last.dataset.reviewLine), excerpt);
	}

	function normalizeExcerpt(text) {
		return text.replace(/(^|\\n)[+\\-]/g, "$1").replace(/\\s+/g, " ").trim().slice(0, 160);
	}

	const selectionButton = (() => {
		if (!reviewMode) return null;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "review-selection-btn";
		button.hidden = true;
		document.body.appendChild(button);
		return button;
	})();
	let pendingSelection = null;
	let selectionMouseDown = false;

	function closestReviewRow(node) {
		const el = node && (node.nodeType === 1 ? node : node.parentElement);
		return el ? el.closest("tr.review-line") : null;
	}

	function hideSelectionButton() {
		pendingSelection = null;
		if (selectionButton) selectionButton.hidden = true;
	}

	function evaluateSelection() {
		if (!selectionButton) return;
		const sel = getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) return hideSelectionButton();
		const range = sel.getRangeAt(0);
		const startRow = closestReviewRow(range.startContainer);
		const endRow = closestReviewRow(range.endContainer);
		if (!startRow || !endRow) return hideSelectionButton();
		const wrapper = startRow.closest(".d2h-file-wrapper");
		if (endRow.closest(".d2h-file-wrapper") !== wrapper) return hideSelectionButton();
		if (startRow.closest(".d2h-file-side-diff") !== endRow.closest(".d2h-file-side-diff")) return hideSelectionButton();
		const rows = Array.from(wrapper.querySelectorAll("tr.review-line")).filter((row) => range.intersectsNode(row));
		const linesOf = (which) => rows.filter((row) => row.dataset.reviewSide === which).map((row) => Number(row.dataset.reviewLine));
		const newLines = linesOf("new");
		const oldLines = linesOf("old");
		const side = newLines.length ? "new" : "old";
		const lines = side === "new" ? newLines : oldLines;
		if (!lines.length) return hideSelectionButton();
		const line = Math.min(...lines);
		const endLine = Math.max(...lines);
		const oldRange = side === "new" && oldLines.length ? { line: Math.min(...oldLines), endLine: Math.max(...oldLines) } : null;
		pendingSelection = { path: wrapper.dataset.path, side, line, endLine, oldRange, excerpt: normalizeExcerpt(sel.toString()) };
		const bare = (from, to) => (to === from ? String(from) : from + "–" + to);
		selectionButton.textContent = oldRange
			? "Comment old " + bare(oldRange.line, oldRange.endLine) + " + new " + bare(line, endLine)
			: "Comment " + (side === "old" ? "old " : "") + (endLine === line ? "line " + line : "lines " + line + "–" + endLine);
		const rects = range.getClientRects();
		const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
		selectionButton.hidden = false;
		const left = Math.min(rect.right + 6 + scrollX, scrollX + innerWidth - selectionButton.offsetWidth - 12);
		selectionButton.style.left = Math.max(scrollX + 4, left) + "px";
		selectionButton.style.top = (rect.bottom + 6 + scrollY) + "px";
	}

	if (selectionButton) {
		selectionButton.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			const info = pendingSelection;
			hideSelectionButton();
			getSelection()?.removeAllRanges();
			if (info) openEditorAt(info.path, info.side, info.line, info.endLine, info.excerpt, info.oldRange);
		});
		document.addEventListener("pointerdown", (event) => {
			if (event.target !== selectionButton) selectionMouseDown = true;
		}, true);
		document.addEventListener("pointerup", () => {
			selectionMouseDown = false;
			setTimeout(evaluateSelection, 0);
		}, true);
		document.addEventListener("selectionchange", () => {
			const sel = getSelection();
			if (!sel || sel.isCollapsed) return hideSelectionButton();
			if (!selectionMouseDown) evaluateSelection();
		});
	}

	function updateReviewBar() {
		const bar = document.querySelector(".review-bar");
		if (!bar) return;
		bar.hidden = !diff.trim() && !comments.length;
		const count = comments.length;
		bar.querySelector(".review-hint").hidden = count > 0 || !!editorState;
		const summary = bar.querySelector(".review-summary");
		summary.hidden = !count;
		summary.textContent = count + (count === 1 ? " comment" : " comments");
		bar.querySelector(".review-submit").hidden = !count;
	}

	document.querySelector(".review-submit")?.addEventListener("click", async (event) => {
		const button = event.currentTarget;
		button.disabled = true;
		button.textContent = "Submitting…";
		const bar = document.querySelector(".review-bar");
		const errorNote = bar.querySelector(".review-error");
		errorNote.hidden = true;
		try {
			const response = await fetch("/review/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ comments }) });
			if (!response.ok) throw new Error(await response.text() || "Submit failed");
			comments = [];
			editorState = null;
			const hint = bar.querySelector(".review-hint");
			hint.textContent = "Review sent to the agent ✓";
			setTimeout(() => { hint.textContent = defaultHint; }, 4000);
			renderComments();
			refresh();
		} catch (error) {
			errorNote.textContent = error.message;
			errorNote.hidden = false;
			setTimeout(() => { errorNote.hidden = true; }, 6000);
		} finally {
			button.disabled = false;
			button.textContent = "Submit review";
		}
	});

	function scrollAnchor() {
		for (const wrapper of document.querySelectorAll(".d2h-file-wrapper")) {
			const rect = wrapper.getBoundingClientRect();
			if (rect.bottom > headerH + 10) return { path: wrapper.dataset.path, top: rect.top };
		}
		return null;
	}

	function restoreScroll(anchor) {
		const target = anchor && wrapperFor(anchor.path);
		if (target) scrollBy(0, target.getBoundingClientRect().top - anchor.top);
	}

	function renderSidebar(commitList) {
		latestCommits = commitList;
		const filesSection = document.querySelector(".files");
		if (filesSection) {
			filesSection.textContent = "";
			const commentCounts = comments.reduce((counts, comment) => {
				counts[comment.path] = (counts[comment.path] || 0) + 1;
				return counts;
			}, {});
			const viewedCount = files.filter(isViewed).length;
			const summary = document.createElement("div");
			summary.className = "review-progress";
			summary.innerHTML = '<strong>' + (reviewMode ? viewedCount + " of " + files.length + " viewed" : files.length + (files.length === 1 ? " file" : " files")) + '</strong>'
				+ (reviewMode ? '<span>' + comments.length + (comments.length === 1 ? " draft comment" : " draft comments") + '</span>' : '');
			filesSection.appendChild(summary);
			if (!files.length) {
				const empty = document.createElement("div");
				empty.className = "files__empty";
				empty.textContent = "No files";
				filesSection.appendChild(empty);
			}
			const groups = reviewMode ? [
				["Commented", files.filter((path) => commentCounts[path])],
				["Needs review", files.filter((path) => !commentCounts[path] && !isViewed(path))],
				["Viewed", files.filter((path) => !commentCounts[path] && isViewed(path))],
			] : [["Changed files", files]];
			for (const [name, paths] of groups) {
				if (!paths.length) continue;
				const group = document.createElement(name === "Viewed" ? "details" : "div");
				group.className = "file-group";
				if (name === "Viewed") {
					const heading = document.createElement("summary");
					heading.className = "section-label";
					heading.textContent = name + " · " + paths.length;
					group.appendChild(heading);
				} else {
					const heading = document.createElement("div");
					heading.className = "section-label";
					heading.textContent = name + " · " + paths.length;
					group.appendChild(heading);
				}
				for (const path of paths) {
					const index = files.indexOf(path);
					const slash = path.lastIndexOf("/");
					const button = document.createElement("button");
					button.className = "file" + (isViewed(path) ? " is-viewed" : "") + (commentCounts[path] ? " has-comments" : "");
					button.type = "button";
					button.dataset.index = String(index);
					button.title = path;
					const status = document.createElement("span");
					status.className = "file-status";
					status.textContent = commentCounts[path] ? "●" : isViewed(path) ? "✓" : "○";
					const text = document.createElement("span");
					text.className = "file-text";
					const nameEl = document.createElement("strong");
					nameEl.textContent = slash < 0 ? path : path.slice(slash + 1);
					text.appendChild(nameEl);
					if (slash >= 0) {
						const parent = document.createElement("span");
						parent.textContent = path.slice(0, slash + 1);
						text.appendChild(parent);
					}
					button.append(status, text);
					if (commentCounts[path]) {
						const count = document.createElement("span");
						count.className = "file-count";
						count.textContent = String(commentCounts[path]);
						button.appendChild(count);
					}
					group.appendChild(button);
				}
				filesSection.appendChild(group);
			}
		}
		const reviewTab = document.querySelector('.tabs a[href="/"]');
		if (reviewTab && reviewMode) reviewTab.textContent = files.length ? "Review · " + files.length : "Review";
		const commitsSection = document.querySelector(".commits");
		if (commitsSection) {
			commitsSection.textContent = "";
			const details = document.createElement("details");
			details.className = "history";
			const label = document.createElement("summary");
			label.className = "section-label";
			label.textContent = "History" + (commitList.length ? " · " + commitList.length : "");
			details.appendChild(label);
			if (!commitList.length) {
				const empty = document.createElement("div");
				empty.className = "files__empty";
				empty.textContent = "No commits";
				details.appendChild(empty);
			}
			for (const commit of commitList) {
				const link = document.createElement("a");
				const path = "/commit/" + commit.sha;
				link.className = location.pathname === path ? "commit active" : "commit";
				link.href = path;
				const sha = document.createElement("b");
				sha.textContent = commit.shortSha;
				const when = document.createElement("span");
				when.textContent = commit.when;
				link.append(sha, " " + commit.subject, when);
				details.appendChild(link);
			}
			commitsSection.appendChild(details);
		}
	}

	async function refresh() {
		const activeEditor = document.querySelector(".review-editor textarea");
		if (refreshing || (activeEditor && (activeEditor === document.activeElement || activeEditor.value.trim()))) {
			pendingRefresh = true;
			return;
		}
		refreshing = true;
		try {
			const response = await fetch(location.pathname, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error("Refresh failed");
			const data = await response.json();
			diff = data.diff;
			files = data.files;
			signatures = data.signatures;
			viewed = Object.fromEntries(files.filter((path) => data.viewed?.[path] === signatures[path]).map((path) => [path, data.viewed[path]]));
			latestCommits = data.commits || [];
			renderSidebar(latestCommits);
			const anchor = scrollAnchor();
			draw();
			restoreScroll(anchor);
		} catch {
			location.reload();
			return;
		} finally {
			refreshing = false;
		}
		if (pendingRefresh) {
			pendingRefresh = false;
			refresh();
		}
	}

	function draw() {
		hideSelectionButton();
		container.textContent = "";
		if (!diff.trim()) {
			const empty = document.createElement("p");
			empty.className = "empty";
			empty.textContent = emptyMessage;
			container.appendChild(empty);
			if (reviewMode) renderComments();
			return;
		}
		new Diff2HtmlUI(container, diff, {
			colorScheme: "dark",
			diffMaxChanges: 3000,
			diffMaxLineLength: 2000,
			diffTooBigMessage: () => "Diff too large to render. Narrow the path or commit range.",
			highlight: false,
			matching: "none",
			outputFormat,
		}).draw();
		assignFileAnchors();
		wireFileListCollapse();
		if (reviewMode) {
			wireReviewLines();
			renderComments();
		}
		updateModeButtons();
	}

	modeButtons.forEach((button) => button.addEventListener("click", () => {
		outputFormat = button.dataset.mode;
		draw();
	}));

	document.querySelector(".files")?.addEventListener("click", (event) => {
		const item = event.target.closest(".file");
		if (!item) return;
		document.getElementById("file-" + item.dataset.index)?.scrollIntoView({ behavior: "smooth", block: "start" });
		setActive(item.dataset.index);
	});

	restoreDrafts();
	renderSidebar(latestCommits);
	draw();
	return { draw, refresh };
}

function reviewWorkspaceSource() {
	return `globalThis.piDiffReviewWorkspace = (${createReviewWorkspace.toString()})(JSON.parse(document.getElementById("pi-diff-state").textContent));`;
}

const http = require("node:http");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readlinkSync, statSync } = require("node:fs");
const { basename, isAbsolute, join, relative, resolve } = require("node:path");
const { promisify } = require("node:util");
const chokidar = require("chokidar");

const execFileAsync = promisify(execFile);
const diffCss = readFileSync(require.resolve("diff2html/bundles/css/diff2html.min.css"), "utf8");
const diffUiJs = readFileSync(require.resolve("diff2html/bundles/js/diff2html-ui-base.min.js"), "utf8");
const RELOAD_DEBOUNCE_MS = 150;
const RELOAD_SAFETY_POLL_MS = 15000;

let server;
const reloadClients = new Set();

function stopServer() {
	server?.close();
	server = undefined;
	void stopChangeMonitor();
	for (const res of reloadClients) res.end();
	reloadClients.clear();
}

function shlex(input) {
	if (/[\\"']/.test(input)) throw new Error("Quoted/escaped args are not supported; pass plain git diff args.");
	return input.trim() ? input.trim().split(/\s+/) : [];
}

async function git(cwd, args) {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
		return stdout;
	} catch (error) {
		const wrapped = new Error(error.stderr || error.message);
		wrapped.code = error.code;
		wrapped.stdout = error.stdout || "";
		throw wrapped;
	}
}

function untrackedPathspecs(diffArgs) {
	const dash = diffArgs.indexOf("--");
	if (dash !== -1) return diffArgs.slice(dash + 1);
	if (diffArgs.some((arg) => arg.startsWith("-"))) return null;
	return diffArgs;
}

function untrackedSymlinkDiff(cwd, file) {
	const target = readlinkSync(join(cwd, file));
	const endsWithNewline = target.endsWith("\n");
	const lines = (endsWithNewline ? target.slice(0, -1) : target).split("\n");
	return [
		`diff --git a/${file} b/${file}`,
		"new file mode 120000",
		"--- /dev/null",
		`+++ b/${file}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((line) => `+${line}`),
		...(endsWithNewline ? [] : ["\\ No newline at end of file"]),
	].join("\n");
}

async function untrackedDiff(cwd, diffArgs) {
	const pathspecs = untrackedPathspecs(diffArgs);
	if (!pathspecs) return "";
	const output = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs]);
	const files = output.split("\0").filter(Boolean);
	const diffs = await Promise.all(files.map(async (file) => {
		if (lstatSync(join(cwd, file)).isSymbolicLink()) return untrackedSymlinkDiff(cwd, file);
		try {
			return await git(cwd, ["diff", "--no-ext-diff", "--no-color", "--no-index", "--", "/dev/null", file]);
		} catch (error) {
			if (error.code === 1 && error.stdout) return error.stdout;
			throw error;
		}
	}));
	return diffs.filter(Boolean).join("\n");
}

async function workingTreeDiff(cwd, diffArgs) {
	const diff = await git(cwd, ["diff", "--no-ext-diff", "--no-color", ...diffArgs]);
	const untracked = await untrackedDiff(cwd, diffArgs);
	return [diff.trimEnd(), untracked.trimEnd()].filter(Boolean).join("\n");
}

function statusFiles(output) {
	const records = output.split("\0").filter(Boolean);
	const files = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record[2] !== " ") continue;
		files.push(record.slice(3));
		if (record[0] === "R" || record[0] === "C") i++;
	}
	return files;
}

async function changeKey(cwd) {
	const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	const stats = statusFiles(status).map((file) => {
		try {
			const stat = statSync(join(cwd, file));
			return `${file}\0${stat.size}\0${stat.mtimeMs}`;
		} catch {
			return `${file}\0missing`;
		}
	});
	return [status, ...stats].join("\0");
}

async function gitDir(cwd) {
	const dir = (await git(cwd, ["rev-parse", "--git-dir"])).trim();
	return isAbsolute(dir) ? resolve(dir) : resolve(cwd, dir);
}

async function ignoredRoots(cwd) {
	const output = await git(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
	return Array.from(new Set(output.split("\0")
		.filter(Boolean)
		.map((path) => path.replace(/[\\/]+$/, ""))
		.filter(Boolean)
		.map((path) => resolve(cwd, path))));
}

function pathContains(root, path) {
	const rel = relative(root, path);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function createMonitorState(options = {}) {
	return {
		cwd: null,
		gitDirPath: null,
		workingWatcher: null,
		gitWatcher: null,
		debounceTimer: null,
		safetyTimer: null,
		lastKey: null,
		checking: false,
		pending: false,
		ignoredRootCache: [],
		token: 0,
		changeKeyFn: options.changeKey || changeKey,
		gitDirFn: options.gitDir || gitDir,
		ignoredRootsFn: options.ignoredRoots || ignoredRoots,
		watchFn: options.watch || chokidar.watch,
		notifyFn: options.notify || notifyReloadClients,
		debounceMs: options.debounceMs ?? RELOAD_DEBOUNCE_MS,
		safetyPollMs: options.safetyPollMs ?? RELOAD_SAFETY_POLL_MS,
	};
}

const changeMonitor = createMonitorState();

function notifyReloadClients() {
	for (const res of reloadClients) res.write("data: reload\n\n");
}

function absoluteMonitorPath(path, state = changeMonitor) {
	return isAbsolute(path) ? resolve(path) : resolve(state.cwd || ".", path);
}

function shouldIgnoreWorkingPath(path, state = changeMonitor) {
	const absolute = absoluteMonitorPath(path, state);
	if (!state.cwd) return false;
	if (pathContains(resolve(state.cwd, ".git"), absolute)) return true;
	if (state.gitDirPath && pathContains(state.gitDirPath, absolute)) return true;
	return state.ignoredRootCache.some((root) => pathContains(root, absolute));
}

function isIgnoreMetadataPath(path, state = changeMonitor) {
	const absolute = absoluteMonitorPath(path, state);
	if (basename(absolute) === ".gitignore") return true;
	return !!state.gitDirPath && (
		absolute === join(state.gitDirPath, "info", "exclude") ||
		absolute === join(state.gitDirPath, "config")
	);
}

function gitMetadataPaths(gitDirPath) {
	return [
		"index",
		"HEAD",
		"refs",
		"packed-refs",
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"rebase-apply",
		"rebase-merge",
		join("info", "exclude"),
		"config",
	].map((path) => join(gitDirPath, path));
}

async function refreshIgnoredRootCache(state = changeMonitor, { rescan = false } = {}) {
	if (!state.cwd) return;
	try {
		state.ignoredRootCache = await state.ignoredRootsFn(state.cwd);
		state.workingWatcher?.unwatch?.(state.ignoredRootCache);
		if (rescan) state.workingWatcher?.add?.(state.cwd);
	} catch {}
}

function scheduleReloadCheck(reason, state = changeMonitor, delay = state.debounceMs) {
	if (!state.cwd) return;
	clearTimeout(state.debounceTimer);
	state.debounceTimer = setTimeout(() => {
		state.debounceTimer = null;
		void runReloadCheck(reason, state);
	}, delay);
}

async function runReloadCheck(_reason, state = changeMonitor) {
	if (!state.cwd) return;
	if (state.checking) {
		state.pending = true;
		return;
	}

	state.checking = true;
	try {
		do {
			state.pending = false;
			const cwd = state.cwd;
			let key;
			try {
				key = await state.changeKeyFn(cwd);
			} catch {
				continue;
			}
			if (!state.cwd || state.cwd !== cwd) continue;
			if (state.lastKey === null) {
				state.lastKey = key;
				continue;
			}
			if (key !== state.lastKey) {
				state.lastKey = key;
				state.notifyFn();
				await refreshIgnoredRootCache(state, { rescan: true });
			}
		} while (state.pending && state.cwd);
	} finally {
		state.checking = false;
	}
}

async function startChangeMonitor(cwd, state = changeMonitor) {
	if (state.cwd === cwd && (state.workingWatcher || state.gitWatcher || state.safetyTimer)) return;
	await stopChangeMonitor(state);
	const token = ++state.token;
	state.cwd = cwd;
	try {
		state.lastKey = await state.changeKeyFn(cwd);
	} catch {
		state.lastKey = null;
	}
	try {
		state.gitDirPath = await state.gitDirFn(cwd);
	} catch {
		state.gitDirPath = resolve(cwd, ".git");
	}
	await refreshIgnoredRootCache(state);
	if (state.token !== token || state.cwd !== cwd) return;

	const watchOptions = { ignoreInitial: true, persistent: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 } };
	state.workingWatcher = state.watchFn(cwd, {
		...watchOptions,
		ignored: (path) => shouldIgnoreWorkingPath(path, state),
	});
	state.workingWatcher.on?.("all", (event, path) => {
		if (isIgnoreMetadataPath(path, state)) void refreshIgnoredRootCache(state, { rescan: true });
		scheduleReloadCheck(`working:${event}`, state);
	});
	state.workingWatcher.on?.("error", () => scheduleReloadCheck("working:error", state, 0));

	state.gitWatcher = state.watchFn(gitMetadataPaths(state.gitDirPath), watchOptions);
	state.gitWatcher.on?.("all", (event, path) => {
		if (isIgnoreMetadataPath(path, state)) void refreshIgnoredRootCache(state, { rescan: true });
		scheduleReloadCheck(`git:${event}`, state);
	});
	state.gitWatcher.on?.("error", () => scheduleReloadCheck("git:error", state, 0));

	state.safetyTimer = setInterval(() => scheduleReloadCheck("safety-poll", state, 0), state.safetyPollMs);
	state.safetyTimer.unref?.();
}

async function stopChangeMonitor(state = changeMonitor) {
	state.token++;
	clearTimeout(state.debounceTimer);
	clearInterval(state.safetyTimer);
	state.debounceTimer = null;
	state.safetyTimer = null;
	state.cwd = null;
	state.gitDirPath = null;
	state.lastKey = null;
	state.pending = false;
	state.checking = false;
	state.ignoredRootCache = [];
	const watchers = [state.workingWatcher, state.gitWatcher].filter(Boolean);
	state.workingWatcher = null;
	state.gitWatcher = null;
	await Promise.all(watchers.map(async (watcher) => watcher.close?.()));
}

async function commits(cwd) {
	try {
		await git(cwd, ["rev-parse", "--verify", "HEAD"]);
	} catch {
		return [];
	}

	const output = await git(cwd, ["log", "--date=relative", "--pretty=format:%H%x09%h%x09%cr%x09%s", "-n", "50"]);
	return output.split("\n").filter(Boolean).map((line) => {
		const [sha, shortSha, when, ...subject] = line.split("\t");
		return { sha, shortSha, when, subject: subject.join("\t") };
	});
}

function githubRepo(remote) {
	const trimmed = remote.trim().replace(/\.git$/, "");
	const ssh = trimmed.match(/^git@github\.com:(.+)$/);
	if (ssh) return ssh[1];
	const https = trimmed.match(/^https?:\/\/github\.com\/(.+)$/);
	if (https) return https[1];
	return null;
}

function githubUrl(remote) {
	const repo = githubRepo(remote);
	return repo ? `https://github.com/${repo}` : null;
}

async function repoInfo(cwd) {
	let url = null;
	let branch = null;
	let name = null;
	try {
		name = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).name || null;
	} catch {}
	try {
		const remote = await git(cwd, ["remote", "get-url", "origin"]);
		url = githubUrl(remote);
		name ||= githubRepo(remote);
	} catch {}
	name ||= basename(cwd);
	try {
		const head = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
		if (head && head !== "HEAD") branch = head;
	} catch {}
	return { url, branch, name, issues: url ? `${url}/issues` : null };
}

function extractFiles(diff) {
	const files = [];
	const seen = new Set();
	for (const line of diff.split("\n")) {
		const match = line.match(/^diff --git "?(.+?)"? "?(.+?)"?$/);
		if (!match) continue;
		let path = match[2];
		if (path.startsWith("b/")) path = path.slice(2);
		if (!seen.has(path)) {
			seen.add(path);
			files.push(path);
		}
	}
	return files;
}

function hash(text) {
	return createHash("sha256").update(text).digest("hex");
}

function fileSignatures(diff, files) {
	const chunks = diffChunks(diff);
	return Object.fromEntries(files.map((path, index) => [path, hash(chunks[index] || "")]));
}

function diffChunks(diff) {
	return diff ? diff.split(/\n(?=diff --git )/).filter(Boolean) : [];
}

function sortDiffByMtime(cwd, diff) {
	return diffChunks(diff).map((chunk, index) => {
		const [path] = extractFiles(chunk);
		let mtime = 0;
		try { mtime = statSync(join(cwd, path)).mtimeMs; } catch {}
		return { chunk, path, mtime, index };
	}).sort((a, b) => b.mtime - a.mtime || a.index - b.index).map(({ chunk }) => chunk).join("\n");
}

function reviewDiff(diff, reviewed) {
	return diffChunks(diff).filter((chunk) => {
		const [path] = extractFiles(chunk);
		return reviewed.get(path) !== hash(chunk);
	}).join("\n");
}

function formatReviewFeedback(comments) {
	const groups = new Map();
	for (const comment of comments) {
		if (!groups.has(comment.path)) groups.set(comment.path, []);
		groups.get(comment.path).push(comment);
	}
	const sideRange = (side, line, endLine) => `${side === "old" ? "Old" : "New"} ${endLine && endLine !== line ? `lines ${line}-${endLine}` : `line ${line}`}`;
	const lines = ["Please address the following review comments:"];
	for (const [path, items] of groups) {
		lines.push("", path);
		for (const item of items) {
			const range = item.oldLine
				? `${sideRange("old", item.oldLine, item.oldEndLine)} → ${sideRange("new", item.line, item.endLine)}`
				: sideRange(item.side, item.line, item.endLine);
			const excerpt = item.excerpt ? ` (\`${item.excerpt}\`)` : "";
			const stale = item.stale ? " [written against an earlier version of the file; line numbers may be off]" : "";
			lines.push(`- ${range}${excerpt}: ${item.body.replace(/\n/g, "\n  ")}${stale}`);
		}
	}
	return lines.join("\n");
}

async function view(cwd, pathname, diffArgs, reviewed = new Map()) {
	if (pathname === "/") {
		const diff = reviewDiff(sortDiffByMtime(cwd, await workingTreeDiff(cwd, diffArgs)), reviewed);
		const files = extractFiles(diff);
		return { title: "Review queue", command: `git diff ${diffArgs.join(" ")}`, diff, files, signatures: fileSignatures(diff, files), reviewMode: true };
	}
	if (pathname === "/staged") {
		const diff = await git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-color"]);
		const files = extractFiles(diff);
		return { title: "Staged", command: "git diff --cached", diff, files, signatures: fileSignatures(diff, files) };
	}

	const match = pathname.match(/^\/commit\/([0-9a-f]{7,40})$/i);
	if (match) {
		const [commit] = match.slice(1);
		const title = (await git(cwd, ["show", "-s", "--format=%h %s", commit])).trim();
		const diff = await git(cwd, ["show", "--format=", "--no-ext-diff", "--no-color", commit]);
		const files = extractFiles(diff);
		return { title, command: `git show ${commit}`, diff, files, signatures: fileSignatures(diff, files) };
	}

	throw new Error("Not found");
}

function page({ cwd, currentPath, title, command, diff, files, signatures = {}, viewed = {}, commits, repo, reviewMode = false }) {
	const commitList = commits.map((commit) => {
		const path = `/commit/${commit.sha}`;
		const active = currentPath === path ? " active" : "";
		return `<a class="commit${active}" href="${path}"><b>${escapeHtml(commit.shortSha)}</b> ${escapeHtml(commit.subject)}<span>${escapeHtml(commit.when)}</span></a>`;
	}).join("");

	const fileList = files.map((path, index) =>
		`<button class="file" type="button" data-index="${index}" title="${escapeHtml(path)}"><span class="file-path">&#x2068;${escapeHtml(path)}&#x2069;</span></button>`
	).join("");

	const icon = {
		pr: '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>',
		branch: '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>',
		github: '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 3.87c.68 0 1.36.09 2 .26 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
		report: '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.75 1a.75.75 0 0 1 .75.75V2h7.19c.72 0 1.17.78.8 1.4L10.97 6l1.52 2.6c.37.62-.08 1.4-.8 1.4H4.5v4.25a.75.75 0 0 1-1.5 0V1.75A.75.75 0 0 1 3.75 1Zm.75 2.5v5h6.32L9.53 6.3a.75.75 0 0 1 0-.76l1.3-2.04H4.5Z"/></svg>',
	};
	const links = [];
	if (repo.issues) {
		links.push(`<a class="icon-link" href="${repo.issues}" target="_blank" rel="noreferrer" title="回報 issue">${icon.report}</a>`);
	}
	if (repo.url && repo.branch) {
		const branch = encodeURIComponent(repo.branch);
		links.push(`<a class="icon-link" href="${repo.url}/compare/${branch}?expand=1" target="_blank" rel="noreferrer" title="在 GitHub 開啟此分支的 PR 建立頁">${icon.pr}</a>`);
		links.push(`<a class="icon-link" href="${repo.url}/tree/${branch}" target="_blank" rel="noreferrer" title="在 GitHub 檢視此分支 (${escapeHtml(repo.branch)})">${icon.branch}</a>`);
	}
	if (repo.url) {
		links.push(`<a class="icon-link" href="${repo.url}" target="_blank" rel="noreferrer" title="在 GitHub 開啟此 repo">${icon.github}</a>`);
	}
	const headerLinks = links.join("");
	const rawProjectName = repo.name || "pi-diff";
	const projectName = escapeHtml(rawProjectName);
	const pageTitle = escapeHtml(repo.branch ? `${rawProjectName} · ${repo.branch}` : rawProjectName);
	const branchMeta = repo.branch ? ` · ${escapeHtml(repo.branch)}` : "";
	const logo = repo.url
		? `<a class="logo" href="${repo.url}" target="_blank" rel="noreferrer">${projectName}</a>`
		: `<span class="logo">${projectName}</span>`;

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<link id="server-icon" rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%2322c55e'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/diff2html.css">
<style>
	:root {
		--brand: #7c3aed;
		--bg: #0d1117;
		--panel: #161b22;
		--panel-2: #21262d;
		--border: #30363d;
		--text: #e6edf3;
		--dim: #8b949e;
		--header-h: 42px;
	}
	* { box-sizing: border-box; border-radius: 0 !important; }
	body { margin: 0; background: var(--bg); color: var(--text); font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
	a { color: inherit; text-decoration: none; }
	button { font: inherit; color: inherit; cursor: pointer; }

	header { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px; height: var(--header-h); padding: 0 10px; background: #010409; border-bottom: 1px solid var(--border); }
	.logo { margin: 0; font-size: 15px; font-weight: 700; white-space: nowrap; }
	a.logo:hover { color: var(--brand); }
	.server-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50% !important; background: #22c55e; }
	.server-dot.off { background: #ef4444; }
	.meta { flex: 1 1 auto; min-width: 0; color: var(--dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.icon-links { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
	.icon-link { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; color: var(--dim); }
	.icon-link:hover { color: var(--text); background: var(--panel-2); }
	.menu-toggle { display: none; flex: 0 0 auto; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; background: transparent; color: var(--dim); cursor: pointer; font-size: 18px; }
	.menu-toggle:hover { color: var(--text); }

	.toolbar__controls { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
	.segmented-control { display: flex; background: var(--panel); border: 1px solid var(--border); overflow: hidden; }
	.segmented-control button { padding: 5px 10px; border: 0; background: transparent; color: var(--dim); font-size: 12px; }
	.segmented-control button.is-active { background: var(--brand); color: #fff; }
	.segmented-control button:hover:not(.is-active) { background: var(--panel-2); color: var(--text); }

	.layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); width: 100%; margin: 0; }
	.sidebar { position: sticky; top: var(--header-h); align-self: start; max-height: calc(100vh - var(--header-h)); overflow: auto; border-right: 1px solid var(--border); background: var(--panel); }

	.tabs { display: flex; position: sticky; top: 0; z-index: 1; border-bottom: 1px solid var(--border); background: var(--panel); }
	.tabs a { flex: 1 1 0; padding: 9px 8px; text-align: center; font-size: 12px; font-weight: 600; color: var(--dim); border-bottom: 2px solid transparent; }
	.tabs a:hover { color: var(--text); background: var(--panel-2); }
	.tabs a.active { color: var(--text); border-bottom-color: var(--brand); }

	.section-label { padding: 8px 12px 6px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dim); }
	.files { border-bottom: 1px solid var(--border); }
	.review-progress { display: flex; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); font-size: 12px; }
	.review-progress strong { font-weight: 600; }
	.review-progress span { color: var(--dim); }
	.file-group + .file-group { border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
	details > summary { cursor: pointer; list-style: none; }
	details > summary::-webkit-details-marker { display: none; }
	details > summary::after { content: "›"; float: right; font-size: 15px; line-height: 11px; transform: rotate(0); transition: transform 120ms ease-out; }
	details[open] > summary::after { transform: rotate(90deg); }
	.commits { border-bottom: 1px solid var(--border); }
	.commit, .file { display: flex; width: 100%; padding: 8px 12px; border: 0; border-left: 2px solid transparent; background: transparent; text-align: left; }
	.commit:hover, .file:hover { background: var(--panel-2); }
	.commit.active, .file.active { background: var(--panel-2); border-left-color: var(--brand); }
	.commit { display: block; color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.commit span { display: block; color: var(--dim); font-size: 12px; margin-top: 2px; }
	.file { align-items: center; gap: 9px; min-height: 46px; color: var(--text); cursor: pointer; }
	.file-status { width: 14px; flex: 0 0 auto; color: var(--dim); text-align: center; }
	.file.has-comments .file-status { color: #a78bfa; }
	.file.is-viewed .file-status { color: #3fb950; }
	.file-text { min-width: 0; flex: 1 1 auto; }
	.file-text strong, .file-text span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.file-text strong { font-size: 13px; font-weight: 600; }
	.file-text span { margin-top: 2px; color: var(--dim); font-size: 11px; }
	.file-count { min-width: 20px; padding: 2px 6px; color: #ddd6fe; background: color-mix(in srgb, var(--brand) 28%, transparent); border-radius: 10px !important; text-align: center; font-size: 11px; }
	.files__empty { padding: 8px 12px 12px; color: var(--dim); font-size: 12px; }
	.content { min-width: 0; }
	.content h2 { margin: 0 0 12px; font-size: 16px; font-weight: 600; word-break: break-word; }
	.d2h-code-line-ctn { white-space: pre-wrap; overflow-wrap: anywhere; }

	.scrim { display: none; position: fixed; inset: var(--header-h) 0 0; z-index: 8; background: rgba(1, 4, 9, .6); }

	.d2h-file-list-wrapper { display: none; position: sticky; top: var(--header-h); z-index: 1; max-height: min(50vh, 420px); overflow: auto; border-color: var(--brand); box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 40%, transparent); cursor: pointer; }
	.d2h-file-list { cursor: default; }
	.d2h-file-list-header { padding: 8px 10px; }
	.d2h-file-header { background: linear-gradient(90deg, color-mix(in srgb, var(--brand) 22%, var(--panel)), var(--panel)); }
	.d2h-file-header.d2h-sticky-header { top: calc(var(--header-h) + var(--file-list-h, 0px)); }
	.empty { padding: 40px; text-align: center; color: var(--dim); }
	.review-line { position: relative; }
	.review-line .d2h-code-linenumber, .review-line .d2h-code-side-linenumber { cursor: pointer; user-select: none; }
	.review-line .d2h-code-linenumber::after, .review-line .d2h-code-side-linenumber::after { content: "+"; position: absolute; left: 3px; top: 50%; width: 16px; height: 16px; margin-top: -8px; line-height: 16px; text-align: center; font-size: 13px; font-weight: 700; color: #fff; background: var(--brand); opacity: 0; transform: scale(.5); transition: opacity .08s ease, transform .08s ease; pointer-events: none; }
	.review-line:hover .d2h-code-linenumber::after, .review-line:hover .d2h-code-side-linenumber::after { opacity: 1; transform: scale(1); }
	.review-line:hover > td { box-shadow: inset 3px 0 var(--brand); }
	.review-line.review-selected > td { background: color-mix(in srgb, var(--brand) 34%, #161b22) !important; box-shadow: inset 3px 0 #58a6ff; }
	.review-line.review-commented > td { background: color-mix(in srgb, var(--brand) 18%, #161b22) !important; }
	body.review-selecting { cursor: ns-resize; user-select: none; }
	.review-comment-row td { padding: 0; background: #0d1117; border-bottom: 1px solid var(--border); }
	.review-spacer-row td { padding: 0; border: 0; background: #0d1117; }
	.review-comment { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; border-left: 3px solid var(--brand); }
	.review-comment-main { flex: 1 1 auto; min-width: 0; }
	.review-comment-meta { display: flex; gap: 10px; margin-bottom: 2px; color: var(--dim); font-size: 12px; }
	.review-stale { color: #d29922; }
	.review-comment-body { white-space: pre-wrap; overflow-wrap: anywhere; }
	.review-comment-actions { display: flex; gap: 2px; flex: 0 0 auto; }
	.review-comment-actions button { padding: 2px 6px; border: 0; background: transparent; color: var(--dim); }
	.review-comment-actions button:hover { color: var(--text); background: var(--panel-2); }
	.review-editor { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 12px; align-items: start; padding: 8px 12px; }
	.review-editor-label { grid-row: 1; color: var(--dim); font-size: 12px; white-space: nowrap; padding-top: 9px; }
	.review-editor textarea { grid-column: 2; width: 100%; min-height: 64px; resize: vertical; color: var(--text); background: #0d1117; border: 1px solid var(--brand); padding: 8px; font: inherit; }
	.review-editor-actions { grid-column: 2; display: flex; justify-content: flex-start; gap: 8px; }
	.review-editor button, .review-submit { color: white; background: var(--brand); border: 0; padding: 8px 12px; cursor: pointer; }
	.review-editor .review-cancel { color: var(--text); background: #30363d; }
	.review-bar { position: fixed; right: 20px; bottom: 20px; z-index: 20; display: flex; align-items: center; gap: 12px; max-width: min(90vw, 520px); padding: 10px 12px; color: var(--text); background: #161b22; border: 1px solid var(--border); box-shadow: 0 8px 24px #010409aa; }
	.review-bar[hidden] { display: none; }
	.review-submit:disabled { opacity: .55; cursor: wait; }
	.review-hint { color: var(--dim); font-size: 12px; }
	.review-error { color: #f85149; font-size: 12px; }
	.review-orphans { margin: 10px; padding: 10px 12px; border: 1px solid #d2992255; background: #161b22; font-size: 13px; }
	.review-orphans-title { margin-bottom: 6px; color: #d29922; }
	.review-orphan { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
	.review-orphan button { border: 0; background: transparent; color: var(--dim); }
	.review-orphan button:hover { color: var(--text); }
	.review-selection-btn { position: absolute; z-index: 2147483000; padding: 5px 10px; color: #fff; background: var(--brand); border: 1px solid color-mix(in srgb, #fff 25%, var(--brand)); box-shadow: 0 4px 12px #01040966; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
	.review-selection-btn[hidden] { display: none; }

	@media (max-width: 900px) {
		.menu-toggle { display: flex; }
		.layout { grid-template-columns: minmax(0, 1fr); margin: 0; }
		.sidebar {
			position: fixed; top: var(--header-h); left: 0; z-index: 9;
			width: min(85vw, 320px); max-height: none; height: calc(100vh - var(--header-h));
			border-right: 1px solid var(--border);
			transform: translateX(-100%); transition: transform .2s ease;
		}
		body.menu-open .sidebar { transform: translateX(0); }
		body.menu-open .scrim { display: block; }
		.toolbar__controls { display: none; }
		.d2h-file-list-wrapper { display: block; }
	}
</style>
</head>
<body>
<header>
	<button class="menu-toggle" type="button" aria-label="Toggle commits">☰</button>
	${logo}
	<span class="server-dot" title="Diff server connected" aria-label="Diff server connected"></span>
	<span class="meta">${escapeHtml(cwd)}${branchMeta} · ${escapeHtml(command)}</span>
	<div class="toolbar__controls">
		<div class="segmented-control" role="tablist" aria-label="Diff view mode">
			<button class="view-mode" data-mode="line-by-line" type="button">Unified</button>
			<button class="view-mode" data-mode="side-by-side" type="button">Split</button>
		</div>
	</div>
	<div class="icon-links">${headerLinks}</div>
</header>
<div class="scrim"></div>
<main class="layout">
	<aside class="sidebar">
		<nav class="tabs">
			<a class="${currentPath === "/" ? "active" : ""}" href="/">Review${reviewMode && files.length ? ` · ${files.length}` : ""}</a>
			<a class="${currentPath === "/staged" ? "active" : ""}" href="/staged">Staged</a>
		</nav>
		<section class="files">
			<div class="section-label">Files${files.length ? ` · ${files.length}` : ""}</div>
			${fileList || '<div class="files__empty">No files</div>'}
		</section>
		<section class="commits">
			<div class="section-label">Commits</div>
			${commitList || '<div class="files__empty">No commits</div>'}
		</section>
	</aside>
	<section class="content"><div id="diff">${diff.trim() ? "" : `<p class="empty">${reviewMode ? "Review queue is clear. Waiting for new agent changes…" : "No diff."}</p>`}</div></section>
</main>
${reviewMode ? `<div class="review-bar"${diff.trim() ? "" : " hidden"}><span class="review-hint">Select code or drag line numbers to comment</span><span class="review-summary" hidden></span><span class="review-error" hidden></span><button class="review-submit" type="button" hidden title="Send all comments to the agent">Submit review</button></div>` : ""}
<script src="/diff2html-ui.js"></script>
<script id="pi-diff-state" type="application/json">${scriptJson({ diff, files, signatures, reviewMode, viewed, commits, emptyMessage: reviewMode ? "Review queue is clear. Waiting for new agent changes…" : "No diff." })}</script>
<script src="/review-workspace.js"></script>
</body>
</html>`;
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function scriptJson(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > 256 * 1024) reject(new Error("Request too large"));
		});
		req.on("end", () => {
			try { resolve(JSON.parse(body || "{}")); } catch (error) { reject(error); }
		});
		req.on("error", reject);
	});
}

async function openBrowser(target) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
	execFile(command, args, { stdio: "ignore", detached: true }).unref();
}

module.exports = function piDiff(pi) {
	async function start(args, ctx) {
		const diffArgs = shlex(args || "");
		stopServer();
		const viewedState = new Map();
		const reviewedState = new Map();

		server = http.createServer(async (req, res) => {
			const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
			if (pathname === "/diff2html.css") {
				res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
				res.end(diffCss);
				return;
			}
			if (pathname === "/diff2html-ui.js") {
				res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
				res.end(diffUiJs);
				return;
			}
			if (pathname === "/review-workspace.js") {
				res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
				res.end(reviewWorkspaceSource());
				return;
			}
			if (pathname === "/events") {
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				const shouldStartMonitor = reloadClients.size === 0;
				reloadClients.add(res);
				if (shouldStartMonitor) void startChangeMonitor(ctx.cwd);
				req.on("close", () => {
					reloadClients.delete(res);
					if (reloadClients.size === 0) void stopChangeMonitor();
				});
				return;
			}

			try {
				if (pathname === "/viewed" && req.method === "POST") {
					const { currentPath, path, signature, checked } = await readJson(req);
					if (typeof currentPath === "string" && typeof path === "string" && typeof signature === "string") {
						const key = `${currentPath}\0${path}`;
						checked ? viewedState.set(key, signature) : viewedState.delete(key);
					}
					res.writeHead(204); res.end(); return;
				}
				if (pathname === "/review/submit" && req.method === "POST") {
					if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw new Error("Expected application/json");
					const { comments } = await readJson(req);
					if (!Array.isArray(comments) || !comments.length || comments.length > 200) throw new Error("Add at least one review comment");
					for (const comment of comments) {
						if (!comment || typeof comment.path !== "string" || !comment.path
							|| !["old", "new"].includes(comment.side) || !Number.isInteger(comment.line) || !Number.isInteger(comment.endLine) || comment.endLine < comment.line
							|| typeof comment.body !== "string" || !comment.body.trim() || comment.body.length > 10000
							|| (comment.excerpt !== undefined && (typeof comment.excerpt !== "string" || comment.excerpt.length > 300))
							|| ((comment.oldLine !== undefined || comment.oldEndLine !== undefined)
								&& !(comment.side === "new" && Number.isInteger(comment.oldLine) && Number.isInteger(comment.oldEndLine) && comment.oldEndLine >= comment.oldLine))
							|| (comment.signature !== undefined && typeof comment.signature !== "string")) throw new Error("Invalid review comment");
					}
					const current = await view(ctx.cwd, "/", diffArgs, reviewedState);
					const annotated = comments.map((comment) => ({ ...comment, stale: !current.files.includes(comment.path) || current.signatures[comment.path] !== comment.signature }));
					pi.sendUserMessage(formatReviewFeedback(annotated), { deliverAs: "followUp" });
					for (const path of current.files) reviewedState.set(path, current.signatures[path]);
					res.writeHead(204); res.end(); notifyReloadClients(); return;
				}
				if (pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
				const [data, commitList, repo] = await Promise.all([
					view(ctx.cwd, pathname, diffArgs, reviewedState), commits(ctx.cwd), repoInfo(ctx.cwd),
				]);
				const viewed = Object.fromEntries(data.files.filter((path) => viewedState.get(`${pathname}\0${path}`) === data.signatures[path]).map((path) => [path, data.signatures[path]]));
				if (String(req.headers.accept || "").includes("application/json")) {
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ title: data.title, command: data.command, diff: data.diff, files: data.files, signatures: data.signatures, reviewMode: !!data.reviewMode, viewed, commits: commitList }));
					return;
				}
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(page({ cwd: ctx.cwd, currentPath: pathname, commits: commitList, repo, viewed, ...data }));
			} catch (error) {
				const notFound = error.message === "Not found";
				res.writeHead(notFound ? 404 : 400, { "content-type": "text/plain; charset=utf-8" }); res.end(error.message);
			}
		});

		await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const { port } = server.address();
		const url = `http://127.0.0.1:${port}/`;
		await openBrowser(url);
		ctx.ui.notify(`Review ready: ${url}`, "info");
		const link = `\x1b]8;;${url}\x1b\\\x1b[4mreview\x1b[24m\x1b]8;;\x1b\\`;
		ctx.ui.setStatus("diff", ctx.ui.theme.fg("muted", link));
	}

	pi.registerCommand("diff", {
		description: "Review and annotate agent changes in the browser",
		handler: (args, ctx) => start(args, ctx),
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopServer();
		ctx.ui.setStatus("diff", undefined);
	});
};
