import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	STATUS_REQUEST_EVENT,
	invalidateStatusSection,
	publishStatusSection,
	removeStatusSection,
	type StatusRow,
	type StatusSection,
} from "./status-window/api.ts";

type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

interface PullRequest {
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
	url: string;
	reviewDecision?: string;
}

interface Check {
	name: string;
	workflow?: string;
	state: string;
	bucket: CheckBucket;
	link?: string;
}

interface WorkflowRun {
	name: string;
	workflowName?: string;
	status: string;
	conclusion?: string;
	url: string;
	headBranch?: string;
}

interface GithubState {
	refreshing: boolean;
	updatedAt?: number;
	account?: string;
	authError?: string;
	repo?: string;
	repoError?: string;
	branch?: string;
	pr?: PullRequest;
	checks: Check[];
	runs: WorkflowRun[];
}

function parseJson<T>(text: string, fallback: T): T {
	try { return JSON.parse(text) as T; }
	catch { return fallback; }
}

function shortError(stderr: string, fallback: string): string {
	const firstLine = stderr.trim().split("\n")[0];
	if (!firstLine) return fallback;
	if (/no git remotes found|failed to determine base repo/i.test(firstLine)) return "no GitHub remote";
	if (/not logged|authentication|authenticate/i.test(firstLine)) return "not authenticated";
	if (/command not found|ENOENT/i.test(firstLine)) return "gh is not installed";
	return firstLine;
}

export default function githubStatusSection(pi: ExtensionAPI) {
	let state: GithubState = { refreshing: false, checks: [], runs: [] };
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshPromise: Promise<void> | undefined;
	let disposed = false;
	let hidden = false;

	const section: StatusSection = {
		id: "github",
		priority: 50,
		visible: () => !hidden,
		getSnapshot: () => {
			const rows: StatusRow[] = [];
			rows.push(state.account
				? { label: "Auth", icon: "", text: `@${state.account}`, tone: "success" }
				: { label: "Auth", icon: "", text: state.authError ?? "not authenticated", tone: "error" });
			rows.push(state.repo
				? { label: "Repo", text: state.repo, tone: "accent" }
				: { label: "Repo", text: state.repoError ?? "no GitHub remote", tone: "warning" });
			rows.push({ label: "Branch", icon: "", text: state.branch ?? "detached", tone: "warning" });

			if (state.pr) {
				const pr = state.pr;
				const prState = pr.isDraft ? "DRAFT" : pr.state;
				rows.push({ label: "PR", icon: "", text: `#${pr.number} ${prState}`, tone: pr.isDraft ? "dim" : pr.state === "OPEN" ? "success" : "warning" });
				rows.push({ text: pr.title, tone: "text", indent: 10 });
				if (pr.reviewDecision) rows.push({
					label: "Review",
					text: pr.reviewDecision.replaceAll("_", " "),
					tone: pr.reviewDecision === "APPROVED" ? "success" : pr.reviewDecision === "CHANGES_REQUESTED" ? "error" : "warning",
				});
			} else {
				rows.push({ label: "PR", text: "no pull request for branch", tone: "dim" });
			}

			const passed = state.checks.filter((check) => check.bucket === "pass").length;
			const failed = state.checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").length;
			const pending = state.checks.filter((check) => check.bucket === "pending").length;
			const total = state.checks.length;
			if (total) {
				const suffix = failed ? `, ${failed} failed` : pending ? `, ${pending} pending` : "";
				rows.push({
					label: "CI",
					icon: failed ? "" : pending ? "" : "",
					text: `${passed}/${total} passed${suffix}`,
					tone: failed ? "error" : pending ? "warning" : "success",
				});
			} else rows.push({ label: "CI", text: "no PR checks", tone: "dim" });

			for (const run of state.runs.slice(0, 3)) {
				const status = run.status === "completed" ? (run.conclusion ?? "completed") : run.status;
				const failedRun = ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(status);
				const pendingRun = ["queued", "in_progress", "pending", "requested", "waiting"].includes(status);
				rows.push({
					label: "Workflow",
					icon: failedRun ? "" : pendingRun ? "" : status === "success" ? "" : "",
					text: run.workflowName || run.name || "workflow",
					tone: failedRun ? "error" : pendingRun ? "warning" : status === "success" ? "success" : "dim",
				});
			}

			const updated = state.updatedAt
				? `updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
				: "waiting for refresh";
			return {
				title: "GitHub",
				icon: "",
				rows,
				footer: state.refreshing ? ` refreshing · ${updated}` : `${updated} · /gh-status refresh`,
			};
		},
	};

	const publish = () => publishStatusSection(pi, section);
	pi.events.on(STATUS_REQUEST_EVENT, publish);

	const run = async (ctx: ExtensionContext, command: string, args: string[]) => {
		const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 10_000 }).catch((error) => ({
			stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1,
		}));
		return { ok: result.code === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
	};

	const refresh = (ctx: ExtensionContext) => {
		if (refreshPromise || disposed) return refreshPromise;
		state = { ...state, refreshing: true };
		invalidateStatusSection(pi, section.id);
		refreshPromise = (async () => {
			const [branchResult, authResult, repoResult] = await Promise.all([
				run(ctx, "git", ["branch", "--show-current"]),
				run(ctx, "gh", ["api", "user", "--jq", ".login"]),
				run(ctx, "gh", ["repo", "view", "--json", "nameWithOwner,url"]),
			]);
			if (disposed) return;
			const branch = branchResult.stdout || undefined;
			const repo = parseJson<{ nameWithOwner?: string }>(repoResult.stdout, {}).nameWithOwner;
			let pr: PullRequest | undefined;
			let checks: Check[] = [];
			let runs: WorkflowRun[] = [];
			if (repo) {
				const [prResult, runsResult] = await Promise.all([
					run(ctx, "gh", ["pr", "view", "--json", "number,title,state,isDraft,url,reviewDecision"]),
					branch ? run(ctx, "gh", ["run", "list", "--branch", branch, "--limit", "3", "--json", "name,workflowName,status,conclusion,url,headBranch"]) : Promise.resolve({ ok: false, stdout: "", stderr: "" }),
				]);
				pr = parseJson<PullRequest | undefined>(prResult.stdout, undefined);
				runs = parseJson<WorkflowRun[]>(runsResult.stdout, []);
				if (pr) {
					const checksResult = await run(ctx, "gh", ["pr", "checks", "--json", "name,workflow,state,bucket,link"]);
					checks = parseJson<Check[]>(checksResult.stdout, []);
				}
			}
			if (disposed) return;
			state = {
				refreshing: false,
				updatedAt: Date.now(),
				account: authResult.ok ? authResult.stdout : undefined,
				authError: authResult.ok ? undefined : shortError(authResult.stderr, "not authenticated"),
				repo,
				repoError: repo ? undefined : shortError(repoResult.stderr, "no GitHub remote"),
				branch, pr, checks, runs,
			};
		})().catch((error) => {
			state = { ...state, refreshing: false, updatedAt: Date.now(), repoError: error instanceof Error ? error.message : String(error) };
		}).finally(() => {
			refreshPromise = undefined;
			invalidateStatusSection(pi, section.id);
		});
		return refreshPromise;
	};

	pi.registerCommand("gh-status", {
		description: "Control or refresh the GitHub status section (show|hide|toggle|refresh)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "refresh") { await refresh(ctx); return; }
			if (action === "show") hidden = false;
			else if (action === "hide") hidden = true;
			else if (action === "toggle") hidden = !hidden;
			else { ctx.ui.notify("Usage: /gh-status show|hide|toggle|refresh", "warning"); return; }
			invalidateStatusSection(pi, section.id);
			if (!hidden) await refresh(ctx);
		},
	});

	pi.on("agent_settled", (_event, ctx) => { void refresh(ctx); });
	pi.on("session_start", (_event, ctx) => {
		disposed = false;
		hidden = false;
		state = { refreshing: false, checks: [], runs: [] };
		publish();
		void refresh(ctx);
		timer = setInterval(() => void refresh(ctx), 30_000);
		timer.unref();
	});
	pi.on("session_shutdown", () => {
		disposed = true;
		if (timer) clearInterval(timer);
		timer = undefined;
		removeStatusSection(pi, section.id);
	});
}
