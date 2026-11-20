/**
 * Eval-only command. Pi's interactive UI handles `/reload`; RPC mode has no
 * reload command. The TUI and this command both end in AgentSession.reload(),
 * which emits session_shutdown with reason "reload". Not a product extension.
 */
export default function evalReload(pi) {
	pi.registerCommand("eval-reload", {
		description: "Eval harness stand-in for interactive /reload",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
}
