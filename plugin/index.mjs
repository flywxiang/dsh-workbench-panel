/**
 * DSH workbench plugin: a sidebar panel plus an HTTP route serving language-model
 * call statistics (daily trends and a call heatmap) from this machine's session
 * logs.
 *
 * The host half (`lib/index.mjs`) registers `/dsh-workbench/api/summary`,
 * `/dsh-workbench/api/health`, and `/dsh-workbench/dashboard.html`. The browser
 * half (`lib/client/index.js`) registers the "工作台" sidebar entry and the panel
 * it opens.
 */
export { apply, inject, BASE_PATH, registerRoutes } from './lib/index.mjs'
