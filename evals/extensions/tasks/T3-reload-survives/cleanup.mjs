import { killRecordedJobs } from "../../harness/sandbox.mjs";

export async function cleanup(ctx) {
	killRecordedJobs(ctx.paths.bgDir);
}
