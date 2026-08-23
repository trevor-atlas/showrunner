import { createRouter, type MiddlewareContext } from "remix/router";
import { staticFiles } from "remix/middleware/static";

import controller from "./actions/controller.tsx";
import runsController from "./actions/runs/controller.tsx";
import runsPhasesController from "./actions/runs/phases/controller.tsx";
import { render } from "./middleware/render.tsx";
import { routes } from "./routes.ts";

type AppContext = MiddlewareContext<[ReturnType<typeof render>]>

declare module "remix/router" {
  interface RouterTypes {
    context: AppContext
  }
}

export const router = createRouter<AppContext>({
  middleware: [staticFiles("./public", { index: false }), render()],
});

router.map(routes, controller);
// §16.12: a controller per route group — the run-detail group and the phases
// group each map the controllers that render them (runs + runs/phases)
router.map(routes.runs, runsController);
router.map(routes.runs.phases, runsPhasesController);
