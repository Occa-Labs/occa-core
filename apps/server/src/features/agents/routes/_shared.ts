// Shared logger for the `routes/agents/*` sub-routers. The earlier
// helpers in this file (respondValidateError / respondProvisionError /
// respondSeedError / rollbackCreate) are gone — provisioning + rollback
// now live inside `services/deployment-create.ts`, which never returns
// adapter-specific error codes to the route layer.

import { childLogger } from "../../../lib/logger";

export const log = childLogger("routes:agents");
