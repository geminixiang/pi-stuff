---
name: ui-evidence
description: Before/after screenshots of a desktop app (macOS, Electron) as evidence. Use when a change shows up in a UI and needs a screenshot, or when attaching an image to a GitHub PR.
---

# UI evidence

A screenshot is evidence only when it reads in five seconds, shows nothing private, and compares the same view in both states.

**Privacy frame**: capture only the target region with `screencapture -x -R x,y,w,h`. Other apps, window titles, sidebars, history and session lists, project names and user names stay out of every saved file. Full-screen shots exist only as throwaway probes for finding coordinates; delete them before you finish.

## Steps

1. **Tools**: run `scripts/build.sh`. It prints a directory containing `mouse` (`click|move|scroll`, real HID events) and `compare` (a labeled side-by-side image).
   - Electron apps ignore System Events `click at`, so use `mouse click`.

   Done when both binaries run.

2. **Isolate**: put the app into each state through its input files.
   - Back up the files and record their sha256.
   - Write the state, then fully restart the app: `osascript -e 'tell application "X" to quit'`, wait until `pgrep` shows a new PID, `open -a X`, then `osascript -e 'tell application "X" to reopen'` if no window appears.
   - Apps cache data, so a reload is not enough.

   Done when the app runs with a new PID that has read the state under test.

3. **Locate**: take one full-screen probe and read off the coordinates of the control and the region to capture. Open menus with `mouse click`. Move the pointer off the region with `mouse move` before capturing: a hover highlight looks like a marker, and a stray click closes the menu. Wait about 2 seconds for tooltips to fade.

   Done when the region shows only the target content, with no hover, tooltip or overlay.

4. **Capture both states at the same anchor**: scroll both to the same anchor items. In a long list, capture frame by frame (scroll, capture, repeat until two frames are identical) and keep the frame holding the difference.

   Done when both captures show the same anchor rows.

5. **Annotate**: build the comparison with `compare OUT LEFT "Before (main)" "<what is wrong>" RIGHT "After (this PR)" "<what changed>" [--box x,y,w,h] [--line y]`.
   - Box what disappears or appears on the left; mark the gap on the right.
   - Crop the right image (`sips -c H W --cropOffset Y X`) so its anchor rows line up with the left.
   - When the UI shows a different name than the code, put the mapping in the note, for example `gpt-image-* shown as Image-*`.

   Done when someone who has not seen the issue can say what changed.

6. **Restore**: write back the backups, run `shasum -c`, and restart the app.

   Done when every checksum passes and the app runs on the original state.

7. **Attach to the PR** with ego-browser:
   - Use the profile where the user is logged in: list them with `profiles()` and create the space with `taskSpace(name, { profileId })`.
   - Upload through the comment box: `waitForFileChooser`, click "Paste, drop, or click to add files", `setFiles`, wait for the `user-attachments/assets/...` URL to appear in the textarea, then select all and delete so nothing gets posted.
   - Put the URL into the body with `gh pr edit --body-file`, together with a caption naming the before and after sources.
   - Reload the PR page and check that the image loads. Confirm the comment count did not change.

   Done when the image renders in the PR body and no comment was posted.

8. **Clean up**: delete the probes and any capture that caught more than the target. Close the browser task with `finish({ keep: [] })`.

   Done when only target-region images remain.
