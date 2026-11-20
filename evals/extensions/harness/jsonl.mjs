/**
 * Split a byte stream on LF only. Unicode line/paragraph separators are legal
 * inside JSON strings, so a readline-style splitter would corrupt records.
 */
export function createJsonlParser(onRecord, onError) {
	let buffer = Buffer.alloc(0);
	return (chunk) => {
		buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		let newline = buffer.indexOf(0x0a);
		while (newline >= 0) {
			let line = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
			newline = buffer.indexOf(0x0a);
			if (!line.length) continue;
			const text = line.toString("utf8");
			try {
				onRecord(JSON.parse(text));
			} catch (error) {
				onError?.(error, text);
			}
		}
	};
}
