/*
 * Generate the desktop-shell patch for the installed DSH bundle.
 *
 * Usage (from the extracted app root or with the temp copy):
 *   node build-patch.mjs --input main.orig.js --output main.patched.js
 *
 * The script is intentionally strict: every anchor must occur exactly once, so
 * a DSH upgrade that changes the shell code fails loudly instead of producing a
 * half-applied patch. It never writes to app.asar.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  return args[index + 1]
}

const inputPath = resolve(arg('input', 'main.orig.js'))
const outputPath = resolve(arg('output', 'main.patched.js'))
const original = readFileSync(inputPath, 'utf8')

const replacements = []

function replaceOnce(label, from, to) {
  const first = original.indexOf(from)
  if (first === -1) throw new Error(`anchor not found: ${label}`)
  if (original.indexOf(from, first + 1) !== -1) throw new Error(`anchor is not unique: ${label}`)
  replacements.push({ label, from, to })
}

const TRAY_MENU_FUNCTION = `/**
 * Context menu for the Windows system tray. The shipped Open/Quit entries keep
 * their exact labels, order, and actions; Restart is inserted between them so
 * the Quit position never moves.
 * @param {object} messages - Current desktop locale messages.
 * @param {{ open: () => void, restart: () => void, quit: () => void }} actions
 */
function trayMenuTemplate(messages, actions) {
	return [{
		label: messages.openApplication,
		click: () => actions.open()
	}, {
		id: "tray-restart",
		// restartApplication is already localized by the shell ("Restart"/"重启").
		label: \`\${messages.restartApplication} DeepSeek Harness\`,
		click: () => actions.restart()
	}, { type: "separator" }, {
		label: messages.quitApplication,
		click: () => actions.quit()
	}];
}
`

replaceOnce(
  'tray menu template + DesktopTray doc',
  `/** Tray icon present for the whole run, not only while the window is hidden. */
var DesktopTray = class {
	options;
	tray;
	/** @param options - Icon path, locale reader, and the open and quit actions. */`,
  `${TRAY_MENU_FUNCTION}/** Tray icon present for the whole run, not only while the window is hidden. */
var DesktopTray = class {
	options;
	tray;
	/** @param options - Icon path, locale reader, and the open, restart, and quit actions. */`,
)

replaceOnce(
  'DesktopTray context menu',
  `		tray.setContextMenu(Menu.buildFromTemplate([
			{
				label: messages.openApplication,
				click: () => {
					this.options.open();
				}
			},
			{ type: "separator" },
			{
				label: messages.quitApplication,
				click: () => {
					this.options.quit();
				}
			}
		]));`,
  `		tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(messages, {
			open: () => this.options.open(),
			restart: () => this.options.restart(),
			quit: () => this.options.quit()
		})));`,
)

const RESTART_FUNCTION = `	/**
	 * Restart the whole desktop application. app.relaunch() preserves the current
	 * executable and argv; quitWithoutConfirmation() runs the shell's existing
	 * shutdown path (backend.close -> DesktopHostProcess.stop escalation) so the
	 * Host and its children are torn down. A detached watchdog observes the
	 * handoff and reports a start failure after the shell has exited.
	 */
	let trayRestartInFlight = false;
	const restartFromTray = () => {
		if (trayRestartInFlight || quitting || shuttingDown) return;
		trayRestartInFlight = true;
		let watchdogProcess;
		const restartDir = join(app.getPath("userData"), "tray-restart");
		const restartLog = join(restartDir, "restart.log");
		const appendRestartLog = (line) => {
			try {
				mkdirSync(restartDir, { recursive: true });
				appendFileSync(restartLog, \`\${new Date().toISOString()} [desktop-tray] \${line}\\n\`);
			} catch (error) {
				console.error("tray restart log:", error);
			}
			console.info("[desktop-tray]", line);
		};
		try {
			mkdirSync(restartDir, { recursive: true });
			const launchedAt = Date.now();
			appendRestartLog(\`restart requested (pid=\${process.pid}, exe=\${process.execPath}, args=\${JSON.stringify(process.argv.slice(1))})\`);
			const watchdogPath = join(process.resourcesPath, "tray-restart-watchdog.cjs");
			let configPath;
			if (existsSync(watchdogPath)) {
				configPath = join(restartDir, \`restart-\${launchedAt}.json\`);
				writeFileSync(configPath, \`\${JSON.stringify({
					version: 1,
					createdAt: launchedAt,
					oldPid: process.pid,
					cutoff: launchedAt,
					executablePath: process.execPath,
					args: process.argv.slice(1),
					cwd: process.cwd(),
					logPath: restartLog,
					receiptPath: join(restartDir, "last-result.json"),
					timeouts: {
						exitMs: 30000,
						forceMs: 8000,
						startMs: 25000,
						settleMs: 2500
					}
				}, null, 2)}\\n\`, "utf8");
			}
			app.relaunch();
			appendRestartLog("app.relaunch() scheduled; quitting");
			if (configPath !== void 0) {
				try {
					watchdogProcess = spawn(process.execPath, [watchdogPath, configPath], {
						detached: true,
						stdio: "ignore",
						windowsHide: true,
						env: {
							...process.env,
							ELECTRON_RUN_AS_NODE: "1"
						}
					});
					watchdogProcess.once("error", (error) => appendRestartLog(\`watchdog spawn error: \${error.message}\`));
					watchdogProcess.unref();
					appendRestartLog(\`watchdog started pid=\${String(watchdogProcess.pid)}\`);
				} catch (error) {
					appendRestartLog(\`watchdog could not be started: \${error instanceof Error ? error.message : String(error)}\`);
				}
			} else appendRestartLog(\`watchdog not found at \${watchdogPath}; relying on app.relaunch()\`);
			quitWithoutConfirmation();
		} catch (error) {
			trayRestartInFlight = false;
			try {
				watchdogProcess?.kill();
			} catch {}
			const detail = error instanceof Error ? error.stack ?? error.message : String(error);
			appendRestartLog(\`restart failed: \${detail}\`);
			dialog.showErrorBox("DeepSeek Harness", \`Restart failed: \${error instanceof Error ? error.message : String(error)}\\nLog: \${restartLog}\`);
		}
	};
`

replaceOnce(
  'restart orchestration in main()',
  `	let quitting = false;
	let startup;`,
  `	let quitting = false;
${RESTART_FUNCTION}	let startup;`,
)

replaceOnce(
  'DesktopTray restart option',
  `			open: () => {
				focusPrimaryWindow();
			},
			quit: () => {
				app.quit();
			}`,
  `			open: () => {
				focusPrimaryWindow();
			},
			restart: () => {
				restartFromTray();
			},
			quit: () => {
				app.quit();
			}`,
)

replaceOnce(
  'isDesktopHostEvent restart-app',
  `		case "quit-inspection": return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === "boolean" && typeof candidate.scheduledTasks === "boolean" && (candidate.error === void 0 || typeof candidate.error === "string");
		default: return false;`,
  `		case "quit-inspection": return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === "boolean" && typeof candidate.scheduledTasks === "boolean" && (candidate.error === void 0 || typeof candidate.error === "string");
		case "restart-app": return Number.isSafeInteger(candidate.requestId);
		default: return false;`,
)

replaceOnce(
  'DesktopHostProcess field',
  `	onPlatformSession;
	onPluginOperation;
	runId;`,
  `	onPlatformSession;
	onPluginOperation;
	onRestartRequest;
	runId;`,
)

replaceOnce(
  'DesktopHostProcess JSDoc + constructor',
  `	* @param onPluginOperation - Optional diagnostic sink; malformed records are ignored without failing the Host.
	*/
	constructor(node, runtimeDir, projectDir, inspectPort, environment = process.env, onFailure, primaryRuntime, packageManager, onPlatformSession, onPluginOperation) {`,
  `	* @param onPluginOperation - Optional diagnostic sink; malformed records are ignored without failing the Host.
	* @param onRestartRequest - Called when the Host asks the shell to restart the application.
	*/
	constructor(node, runtimeDir, projectDir, inspectPort, environment = process.env, onFailure, primaryRuntime, packageManager, onPlatformSession, onPluginOperation, onRestartRequest) {`,
)

replaceOnce(
  'DesktopHostProcess assignment',
  `		this.onPluginOperation = onPluginOperation;
	}`,
  `		this.onPluginOperation = onPluginOperation;
		this.onRestartRequest = onRestartRequest;
	}`,
)

replaceOnce(
  'DesktopHostProcess restart-app dispatch',
  `			if (!isDesktopHostEvent(message)) {
				this.fail(/* @__PURE__ */ new Error("dsh desktop host sent an invalid IPC event"));`,
  `			if (typeof message === "object" && message !== null && message.type === "restart-app" && Number.isSafeInteger(message.requestId)) {
				this.onRestartRequest?.();
				return;
			}
			if (!isDesktopHostEvent(message)) {
				this.fail(/* @__PURE__ */ new Error("dsh desktop host sent an invalid IPC event"));`,
)

replaceOnce(
  'host environment + restart callback',
  `		const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject, hostInspectPort, {
			...hostEnvironment,
			DSH_CLIENT_VERSION: desktopClientVersion()
		}, onFailure, primaryRuntime, resources, (next) => {
			platformView.setSession(next);
		}, (record) => {
			operationJournal ??= new OperationJournal(join(app.getPath("userData"), "plugin-operations"), {
				segmentBytes: 256 * 1024,
				recordBytes: 4096,
				queuedBytes: 64 * 1024
			});
			operationJournal.enqueue(JSON.stringify(record));
		});`,
  `		const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject, hostInspectPort, {
			...hostEnvironment,
			DSH_CLIENT_VERSION: desktopClientVersion(),
			DSH_DESKTOP_RESTART_IPC: "1"
		}, onFailure, primaryRuntime, resources, (next) => {
			platformView.setSession(next);
		}, (record) => {
			operationJournal ??= new OperationJournal(join(app.getPath("userData"), "plugin-operations"), {
				segmentBytes: 256 * 1024,
				recordBytes: 4096,
				queuedBytes: 64 * 1024
			});
			operationJournal.enqueue(JSON.stringify(record));
		}, () => restartFromTray());`,
)

replaceOnce(
  'host stderr diagnostic log',
  `		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-65536);
		});`,
  `		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-65536);
			try {
				const hostLogDir = join(app.getPath("userData"), "tray-restart");
				mkdirSync(hostLogDir, { recursive: true });
				appendFileSync(join(hostLogDir, "host-stderr.log"), chunk);
			} catch {}
		});`,
)

replaceOnce(
  'welcome state transient retry',
  `	const openInitialWindow = async () => {
		if (quitting || recovery.active) return;
		const state = await readWelcomeState();`,
  `	const readWelcomeStateWithRetry = async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await readWelcomeState();
			} catch (error) {
				const code = error?.cause?.code ?? error?.code ?? "";
				const transient = /ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR_SOCKET|fetch failed/iu.test(\`\${error?.message ?? error} \${code}\`);
				if (!transient || attempt >= 2 || quitting) throw error;
				try {
					const startupLogDir = join(app.getPath("userData"), "tray-restart");
					mkdirSync(startupLogDir, { recursive: true });
					appendFileSync(join(startupLogDir, "startup.log"), \`\${new Date().toISOString()} welcome-state read failed (attempt \${attempt + 1}): \${error?.message ?? error} \${code}; retrying\\n\`);
				} catch {}
				console.warn("desktop welcome: transient startup read failure; retrying", error);
				await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
			}
		}
	};
	const openInitialWindow = async () => {
		if (quitting || recovery.active) return;
		const state = await readWelcomeStateWithRetry();`,
)

replaceOnce(
  'host close diagnostic log',
  `		this.exitPromise = new Promise((resolve) => {
			child.once("close", (code) => {
				const suffix = this.stderr.trim() === "" ? "" : \`: \${this.stderr.trim()}\`;
				if (code !== 0 && code !== null) this.fail(/* @__PURE__ */ new Error(\`dsh desktop host exited with \${String(code)}\${suffix}\`));
				else this.fail(/* @__PURE__ */ new Error(\`dsh desktop host stopped\${suffix}\`));
				resolve();
			});
		});`,
  `		this.exitPromise = new Promise((resolve) => {
			child.once("close", (code) => {
				try {
					const hostLogDir = join(app.getPath("userData"), "tray-restart");
					mkdirSync(hostLogDir, { recursive: true });
					appendFileSync(join(hostLogDir, "host-events.log"), \`\${new Date().toISOString()} host close code=\${String(code)} stderrTail=\${JSON.stringify(this.stderr.slice(-2000))}\\n\`);
				} catch {}
				const suffix = this.stderr.trim() === "" ? "" : \`: \${this.stderr.trim()}\`;
				if (code !== 0 && code !== null) this.fail(/* @__PURE__ */ new Error(\`dsh desktop host exited with \${String(code)}\${suffix}\`));
				else this.fail(/* @__PURE__ */ new Error(\`dsh desktop host stopped\${suffix}\`));
				resolve();
			});
		});`,
)

let patched = original
for (const { label, from, to } of replacements) {
  const index = patched.indexOf(from)
  if (index === -1) throw new Error(`internal: anchor marked once but missing: ${label}`)
  patched = patched.slice(0, index) + to + patched.slice(index + from.length)
}

writeFileSync(outputPath, patched, 'utf8')
console.log(`patched ${basename(inputPath)} -> ${basename(outputPath)} (${replacements.length} replacements)`)
for (const { label } of replacements) console.log(`  - ${label}`)
