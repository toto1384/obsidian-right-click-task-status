// Right-Click Task Status: right-click a task in a note to set its status.
// Plain JavaScript, no build step.
//
// - Editor (Live Preview / source): a "Task status" submenu is added to Obsidian's own editor menu. A
//   right-click on the checkbox itself opens the status menu directly. The task is found from the click
//   position (EditorView.posAtCoords), not the cursor, and changed with one undoable editor transaction.
// - Reading view: a post-processor stamps each task <li> with its file line; a right-click on it opens the
//   status menu and the file is changed with Vault.process.
// - With the Tasks plugin, the statuses come from the Tasks settings and the change goes through Tasks'
//   own Task.handleNewStatusWithRecurrenceInUsersOrder (the same code as Tasks' status menu), so done and
//   cancelled dates, recurrence, the new-occurrence position and the global filter all follow the Tasks
//   settings. Tasks does not export its classes, so they are taken from any task in its cache (tasksEngine).
//   Without Tasks (or with "Use the Tasks plugin" off) only the symbol between the brackets changes, and the
//   statuses come from this plugin's own list.

const { Plugin, Menu, PluginSettingTab, Setting, MarkdownView, Notice, TFile } = require("obsidian");
const { EditorView } = require("@codemirror/view");

const TASKS_ID = "obsidian-tasks-plugin";
// Bullet or numbered list item with a checkbox, also inside callouts / quotes
const TASK_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)(\])/;
const TYPES = ["TODO", "IN_PROGRESS", "ON_HOLD", "DONE", "CANCELLED", "NON_TASK"];
const TYPE_NAMES = { TODO: "To do", IN_PROGRESS: "In progress", ON_HOLD: "On hold", DONE: "Done", CANCELLED: "Cancelled", NON_TASK: "Not a task" };
const TYPE_ICONS = { TODO: "circle", IN_PROGRESS: "clock", ON_HOLD: "pause", DONE: "check", CANCELLED: "x", NON_TASK: "minus" };

const DEFAULT_STATUSES = [
	{ symbol: " ", name: "Todo", type: "TODO", nextStatusSymbol: "x" },
	{ symbol: "/", name: "In progress", type: "IN_PROGRESS", nextStatusSymbol: "x" },
	{ symbol: "x", name: "Done", type: "DONE", nextStatusSymbol: " " },
	{ symbol: "-", name: "Cancelled", type: "CANCELLED", nextStatusSymbol: " " },
];
const DEFAULT_SETTINGS = { useTasks: true, submenu: true, checkboxOpensMenu: true, statuses: DEFAULT_STATUSES };

// One entry per symbol (the first wins), sorted by status type
function cleanStatuses(list) {
	const seen = new Set();
	const out = [];
	for (const s of list || []) {
		if (!s || typeof s.symbol !== "string" || s.symbol.length !== 1 || seen.has(s.symbol)) continue;
		seen.add(s.symbol);
		out.push({ symbol: s.symbol, name: s.name || s.symbol, type: TYPES.includes(s.type) ? s.type : "TODO", nextStatusSymbol: s.nextStatusSymbol ?? s.symbol });
	}
	return out.sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type));
}

module.exports = class RightClickTaskStatusPlugin extends Plugin {
	async onload() {
		const data = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.statuses = cleanStatuses(this.settings.statuses).length ? this.settings.statuses : DEFAULT_STATUSES.map((s) => ({ ...s }));
		this.statuses = cleanStatuses(this.settings.statuses);
		this.editorTarget = null;
		this.addSettingTab(new TaskStatusSettingTab(this.app, this));

		// Tasks loads its settings on its own schedule; refresh once the layout is ready, and when its data.json changes
		this.app.workspace.onLayoutReady(() => this.refreshStatuses());
		const tasksData = `${this.app.vault.configDir}/plugins/${TASKS_ID}/data.json`;
		this.registerEvent(this.app.vault.on("raw", (path) => {
			if (path === tasksData) this.refreshStatuses();
		}));

		this.registerMarkdownPostProcessor((el, ctx) => this.stampReadingTasks(el, ctx));
		this.attachTo(document);
		this.registerEvent(this.app.workspace.on("window-open", (_, win) => this.attachTo(win.document)));
		this.registerEvent(this.app.workspace.on("editor-menu", (menu) => {
			const target = this.editorTarget;
			this.editorTarget = null;
			if (target) this.addToEditorMenu(menu, target);
		}));
	}

	attachTo(doc) {
		// Capture phase: runs before Obsidian builds its editor menu
		this.registerDomEvent(doc, "contextmenu", (evt) => this.onContextMenu(evt), { capture: true });
	}

	tasksPlugin() {
		const tp = this.app.plugins?.plugins?.[TASKS_ID];
		return tp && this.app.plugins.enabledPlugins?.has(TASKS_ID) ? tp : null;
	}

	usingTasks() {
		return this.settings.useTasks && !!this.tasksPlugin();
	}

	async refreshStatuses() {
		const tp = this.usingTasks() ? this.tasksPlugin() : null;
		if (!tp) {
			this.statuses = cleanStatuses(this.settings.statuses);
			return;
		}
		try {
			const s = (await tp.loadData())?.statusSettings;
			// Tasks' defaults when it has no saved statuses: Todo and Done, plus In Progress and Cancelled
			this.statuses = cleanStatuses(s ? [...s.coreStatuses, ...s.customStatuses] : DEFAULT_STATUSES);
		} catch (e) {
			console.error("Right-Click Task Status: could not read the Tasks statuses", e);
			this.statuses = cleanStatuses(this.settings.statuses);
		}
	}

	// Tasks' Task, TaskLocation, TasksFile, Status and StatusConfiguration classes, taken from a cached task.
	// Null when Tasks is off, has no tasks yet, or its internals changed.
	tasksEngine() {
		if (!this.usingTasks()) return null;
		const proto = this.tasksPlugin().cache?.getTasks?.()?.[0];
		if (!proto) return null;
		const engine = {
			Task: proto.constructor,
			Location: proto.taskLocation?.constructor,
			File: proto.taskLocation?.tasksFile?.constructor,
			Status: proto.status?.constructor,
			Configuration: proto.status?.configuration?.constructor,
		};
		const ok = typeof engine.Task?.fromLine === "function" && typeof engine.Location?.fromUnknownPosition === "function"
			&& typeof proto.handleNewStatusWithRecurrenceInUsersOrder === "function" && engine.File && engine.Status && engine.Configuration;
		return ok ? engine : null;
	}

	// The new line(s) for a task line given a status: through Tasks when possible (dates, recurrence), else
	// only the symbol changes. Tasks returns null for lines without its global filter: those are plain checkboxes.
	newLinesFor(line, path, status) {
		const engine = this.tasksEngine();
		if (engine) {
			try {
				const task = engine.Task.fromLine({ line, taskLocation: engine.Location.fromUnknownPosition(new engine.File(path)), fallbackDate: null });
				if (task) {
					const newStatus = new engine.Status(new engine.Configuration(status.symbol, status.name, status.nextStatusSymbol, false, status.type));
					return task.handleNewStatusWithRecurrenceInUsersOrder(newStatus).map((t) => t.toFileLineString());
				}
			} catch (e) {
				console.error("Right-Click Task Status: the Tasks plugin could not change this task", e);
			}
		}
		return [line.replace(TASK_RE, (_, start, __, end) => start + status.symbol + end)];
	}

	onContextMenu(evt) {
		this.editorTarget = null;
		const target = evt.target;
		if (typeof target?.closest !== "function" || target.closest("a")) return; // links and tags keep their own menus
		this.refreshStatuses(); // ready for the next right-click; this menu uses the current list

		// Reading view (and rendered blocks inside Live Preview): task items stamped by the post-processor
		const li = target.closest("li[data-rcts-line]");
		if (li) {
			const line = Number(li.dataset.rctsLine);
			const path = li.dataset.rctsPath;
			const symbol = li.dataset.task ?? li.querySelector(":scope > .task-list-item-checkbox, :scope > p > .task-list-item-checkbox")?.dataset.task;
			evt.preventDefault();
			evt.stopPropagation();
			this.showMenu(evt, symbol, (status) => this.applyInFile(path, line, status));
			return;
		}

		const editorEl = target.closest(".cm-editor");
		const view = editorEl && EditorView.findFromDOM(editorEl);
		if (!view) return;
		const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
		if (pos == null) return;
		const line = view.state.doc.lineAt(pos);
		const match = line.text.match(TASK_RE);
		if (!match) return;
		const editorTarget = { view, lineNumber: line.number, path: this.pathFor(editorEl), symbol: match[2] };
		if (this.settings.checkboxOpensMenu && target.closest(".task-list-item-checkbox, .task-list-label")) {
			evt.preventDefault();
			evt.stopPropagation();
			this.showMenu(evt, editorTarget.symbol, (status) => this.applyInEditor(editorTarget, status));
			return;
		}
		this.editorTarget = editorTarget; // used by "editor-menu", which Obsidian fires right after this event
	}

	pathFor(el) {
		let path = "";
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!path && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(el)) path = leaf.view.file?.path || "";
		});
		return path;
	}

	addStatusItems(menu, current, apply) {
		for (const status of this.statuses) {
			menu.addItem((item) => item
				.setTitle(`[${status.symbol}]  ${status.name}`)
				.setIcon(TYPE_ICONS[status.type])
				.setChecked(status.symbol === current)
				.setSection(`rcts-${status.type}`)
				.onClick(() => apply(status)));
		}
	}

	showMenu(evt, current, apply) {
		const menu = new Menu();
		this.addStatusItems(menu, current, apply);
		menu.showAtMouseEvent(evt);
	}

	addToEditorMenu(menu, target) {
		const apply = (status) => this.applyInEditor(target, status);
		let added = false;
		if (this.settings.submenu) {
			menu.addItem((item) => {
				item.setTitle("Task status").setIcon("square-check").setSection("action");
				// setSubmenu is not in the public API typings; fall back to a flat list without it
				if (typeof item.setSubmenu !== "function") return;
				this.addStatusItems(item.setSubmenu(), target.symbol, apply);
				added = true;
			});
		}
		if (!added) this.addStatusItems(menu, target.symbol, apply);
	}

	applyInEditor(target, status) {
		const { view, lineNumber, path } = target;
		if (lineNumber > view.state.doc.lines) return;
		const line = view.state.doc.line(lineNumber);
		if (!TASK_RE.test(line.text)) return new Notice("That line is no longer a task.");
		const lines = this.newLinesFor(line.text, path, status);
		view.dispatch({ changes: { from: line.from, to: line.to, insert: lines.join("\n") } });
	}

	async applyInFile(path, lineIndex, status) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		await this.app.vault.process(file, (data) => {
			const eol = data.includes("\r\n") ? "\r\n" : "\n";
			const lines = data.split(eol);
			if (!TASK_RE.test(lines[lineIndex] ?? "")) {
				new Notice("That line is no longer a task. Try again after the note refreshes.");
				return data;
			}
			lines.splice(lineIndex, 1, ...this.newLinesFor(lines[lineIndex], path, status));
			return lines.join(eol);
		});
	}

	// Reading view: remember each task item's file line and path. Items without section info (rendered by
	// other plugins, e.g. Dataview) and Tasks query results (which have Tasks' own menu) are skipped.
	stampReadingTasks(el, ctx) {
		const items = el.querySelectorAll("li.task-list-item");
		if (!items.length) return;
		const info = ctx.getSectionInfo(el);
		if (!info) return;
		for (const li of items) {
			if (li.closest(".plugin-tasks-query-result")) continue;
			const rel = Number(li.dataset.line);
			if (!Number.isInteger(rel)) continue;
			li.dataset.rctsLine = String(info.lineStart + rel);
			li.dataset.rctsPath = ctx.sourcePath;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		await this.refreshStatuses();
	}
};

class TaskStatusSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		const { settings } = this.plugin;
		containerEl.empty();

		const tasksFound = !!this.plugin.tasksPlugin();
		new Setting(containerEl).setName("Tasks plugin").setHeading();
		new Setting(containerEl)
			.setName("Use the Tasks plugin")
			.setDesc(tasksFound
				? `Tasks is installed: the menu shows your ${this.plugin.statuses.length} Tasks statuses, and done dates, cancelled dates and recurring tasks follow your Tasks settings.`
				: "Tasks is not installed or turned off, so the statuses below are used and only the checkbox symbol changes.")
			.addToggle((t) => t.setValue(settings.useTasks).onChange(async (v) => {
				settings.useTasks = v;
				await this.plugin.saveSettings();
				this.display();
			}));

		new Setting(containerEl).setName("Menu").setHeading();
		new Setting(containerEl)
			.setName("Statuses in a submenu")
			.setDesc("In the editor, put the statuses under one \"Task status\" item instead of listing them all.")
			.addToggle((t) => t.setValue(settings.submenu).onChange(async (v) => {
				settings.submenu = v;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Right-click on a checkbox opens the statuses directly")
			.setDesc("Skip the editor menu when you right-click the checkbox itself.")
			.addToggle((t) => t.setValue(settings.checkboxOpensMenu).onChange(async (v) => {
				settings.checkboxOpensMenu = v;
				await this.plugin.saveSettings();
			}));

		if (this.plugin.usingTasks()) return;
		new Setting(containerEl).setName("Statuses").setHeading()
			.setDesc("One character between the brackets, a name, and a type.");
		settings.statuses.forEach((status, i) => {
			const row = new Setting(containerEl)
				.addText((t) => {
					t.inputEl.maxLength = 1;
					t.inputEl.addClass("rcts-symbol");
					t.setValue(status.symbol).onChange(async (v) => {
						status.symbol = v.length ? v.slice(0, 1) : " ";
						await this.plugin.saveSettings();
					});
				})
				.addText((t) => t.setPlaceholder("Name").setValue(status.name).onChange(async (v) => {
					status.name = v;
					await this.plugin.saveSettings();
				}))
				.addDropdown((d) => {
					for (const type of TYPES) d.addOption(type, TYPE_NAMES[type]);
					d.setValue(status.type).onChange(async (v) => {
						status.type = v;
						await this.plugin.saveSettings();
					});
				})
				.addExtraButton((b) => b.setIcon("trash").setTooltip("Remove status").onClick(async () => {
					settings.statuses.splice(i, 1);
					await this.plugin.saveSettings();
					this.display();
				}));
			row.infoEl.remove();
		});
		new Setting(containerEl).addButton((b) => b.setButtonText("Add status").onClick(async () => {
			settings.statuses.push({ symbol: "?", name: "New status", type: "TODO", nextStatusSymbol: "x" });
			await this.plugin.saveSettings();
			this.display();
		}));
	}
}
