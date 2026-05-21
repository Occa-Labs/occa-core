// GET /api/tool-catalog — list every available tool from the YAML
// catalog under `apps/server/src/features/tools/catalog/`. Used by the
// operator UI to render the "Add Tool" picker and the credential form
// for the selected handler.
//
// The catalog is data, not code. Adding a tool means dropping a YAML
// file in the catalog folder.

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../../middleware/auth";
import { listCatalog } from "../services/catalog-loader";
import { toCatalogWireEntry } from "./_shared";
import type { ToolCatalogResponse } from "@occa/shared/types";

const router: Router = Router();

router.get("/", requireAuth, async (_req: Request, res: Response) => {
  const entries = await listCatalog();
  const body: ToolCatalogResponse = {
    tools: entries.map(toCatalogWireEntry),
  };
  res.json(body);
});

export default router;
