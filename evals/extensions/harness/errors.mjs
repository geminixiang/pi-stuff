import { recordCrash } from "./trace.mjs";

export function captureProcessErrors(trace) {
	const onUncaught = (error) => recordCrash(trace, error, "uncaughtException");
	const onRejection = (error) => recordCrash(trace, error, "unhandledRejection");
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onRejection);
	return () => {
		process.off("uncaughtException", onUncaught);
		process.off("unhandledRejection", onRejection);
	};
}
