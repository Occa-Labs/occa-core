// Re-exports the three routers for the Tools primitive so index.ts can
// mount each at the right path.
//
//   catalogRouter      → /api/tool-catalog            (operator auth)
//   companyToolsRouter → /api/companies/:id/tools     (operator auth, mergeParams)
//   invokeRouter       → /api/tools                   (agent token auth)

export { default as catalogRouter } from "./catalog";
export { default as companyToolsRouter } from "./company-tools";
export { default as invokeRouter } from "./invoke";
