import { findPi, rpcLaunchArgs } from "./extensions.mjs";
import { startRpc } from "./rpc.mjs";
import { applySandboxEnv, createSandbox, disposeSandbox } from "./sandbox.mjs";

/**
 * No-model check that pi can load this repo's unpublished extensions and that
 * /eval-reload reaches session.reload(). Live tasks are separate.
 */
export async function smokeRpc(piBin) {
	const paths = createSandbox("pi-eval-smoke-");
	applySandboxEnv(paths);
	const client = startRpc(findPi(piBin), rpcLaunchArgs({ offline: true, reloadCommand: true }), {
		cwd: paths.workspace,
		env: {
			...process.env,
			HOME: paths.home,
			USERPROFILE: paths.home,
			PI_CODING_AGENT_DIR: paths.agentDir,
			PI_BG_BASH_DIR: paths.bgDir,
			PI_OFFLINE: "1",
		},
	});
	const errors = [];
	client.on((event) => {
		if (event?.type === "extension_error") errors.push(String(event.error ?? "extension error"));
	});
	try {
		await client.request({ type: "get_state" }, 25_000);
		const reloaded = await client.request({ type: "prompt", message: "/eval-reload" }, 25_000);
		if (reloaded.data?.disposition !== "handled") {
			errors.push(`reload disposition ${reloaded.data?.disposition ?? "missing"}`);
		}
		await client.close();
		if (/uncaughtException|Uncaught |UnhandledPromiseRejection/.test(client.stderr)) {
			errors.push("uncaught exception on stderr");
		}
		return { ok: errors.length === 0, errors, stderr: client.stderr.slice(-2000) };
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
		try {
			await client.close();
		} catch {
			// already closing
		}
		return { ok: false, errors, stderr: client.stderr.slice(-2000) };
	} finally {
		disposeSandbox(paths);
	}
}
