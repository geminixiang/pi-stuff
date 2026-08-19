import { PokerRoom } from "./poker-room.ts";
import { route } from "./router.ts";
import type { Env } from "./types.ts";

export { PokerRoom };

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return route(request, env);
	},
} satisfies ExportedHandler<Env>;
