// Public surface of the Context Pipeline. All consumers (chat handler,
// task dispatcher, future heartbeat) import from here.

export { loadContext, ContextNotFoundError } from "./load-context";
export { renderChatPrompt } from "./render-chat";
export {
  loadTaskSurfacePayload,
  renderTaskPrompt,
} from "./render-task";
export type {
  ContextAgent,
  ContextCompany,
  ContextCompanyProfile,
  ContextHistory,
  ContextKnowledge,
  ContextOrg,
  ContextSpec,
  ContextTeammate,
  SurfacePayload,
} from "./spec";
