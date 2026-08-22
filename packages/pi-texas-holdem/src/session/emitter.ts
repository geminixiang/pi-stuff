export interface SessionEmitter {
	subscribe(listener: () => void): () => void;
	emit(): void;
	clear(): void;
}

export function createSessionEmitter(): SessionEmitter {
	const listeners = new Set<() => void>();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit() {
			for (const listener of listeners) listener();
		},
		clear() {
			listeners.clear();
		},
	};
}
