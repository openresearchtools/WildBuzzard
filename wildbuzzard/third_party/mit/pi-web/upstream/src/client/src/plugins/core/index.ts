import type { PiWebPlugin } from "../types";
import { createCoreActions } from "./actions";
import { createCoreWorkspacePanels } from "./panels";

export const corePlugin: PiWebPlugin = {
  apiVersion: 1,
  name: "PI WEB Core",
  activate: () => ({
    contributions: {
      actions: createCoreActions(),
      workspacePanels: createCoreWorkspacePanels(),
    },
  }),
};
