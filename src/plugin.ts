import streamDeck from "@elgato/streamdeck";
import { DeckController } from "./controller.js";
import { CodexDialAction } from "./dial-action.js";
import {
  Agent1, Agent2, Agent3, Agent4, Agent5, Agent6,
  Approve, Back, Decline, Dictation, Fast, Fork, Forward, NewTask,
  HostToggle,
  KeycapAddFiles, KeycapAddPhotos, KeycapApprove, KeycapArchive, KeycapBranch, KeycapBrowser,
  KeycapBug, KeycapCodex, KeycapDiff, KeycapDownload, KeycapGitCommit, KeycapLab,
  KeycapFast, KeycapMerge, KeycapNewTask, KeycapOpenAiDocs, KeycapOpenFolder, KeycapPin, KeycapPlay,
  KeycapPullRequest, KeycapReasoningDown, KeycapReasoningUp, KeycapReject, KeycapSettings,
  KeycapSideChat, KeycapSkills, KeycapSplit, KeycapTasks, KeycapTerminal,
  Plan, RateLimitReset, Reasoning, ReasoningDown, ReasoningUp, Send, Sidebar,
  UsageLimit, UsageOverview
} from "./actions.js";

const controller = new DeckController();

streamDeck.settings.onDidReceiveGlobalSettings<{ showContextRings?: boolean }>((event) => {
  controller.setContextRingVisibility(event.settings.showContextRings !== false);
});

for (const pluginAction of [
  new CodexDialAction(controller),
  new Agent1(controller), new Agent2(controller), new Agent3(controller),
  new Agent4(controller), new Agent5(controller), new Agent6(controller),
  new Fast(controller), new Approve(controller), new Decline(controller),
  new Fork(controller), new Dictation(controller), new Send(controller),
  new Plan(controller), new Reasoning(controller), new ReasoningDown(controller), new ReasoningUp(controller), new NewTask(controller),
  new HostToggle(controller),
  new UsageLimit(controller), new UsageOverview(controller), new RateLimitReset(controller),
  new Back(controller), new Forward(controller), new Sidebar(controller),
  new KeycapFast(controller), new KeycapApprove(controller), new KeycapReject(controller),
  new KeycapSplit(controller), new KeycapNewTask(controller), new KeycapReasoningUp(controller),
  new KeycapReasoningDown(controller),
  new KeycapCodex(controller), new KeycapBug(controller), new KeycapOpenAiDocs(controller),
  new KeycapTerminal(controller), new KeycapDownload(controller), new KeycapArchive(controller),
  new KeycapBrowser(controller), new KeycapPin(controller), new KeycapDiff(controller),
  new KeycapPlay(controller), new KeycapGitCommit(controller), new KeycapBranch(controller),
  new KeycapMerge(controller), new KeycapPullRequest(controller), new KeycapAddPhotos(controller),
  new KeycapLab(controller), new KeycapSideChat(controller), new KeycapTasks(controller),
  new KeycapSettings(controller), new KeycapOpenFolder(controller), new KeycapAddFiles(controller),
  new KeycapSkills(controller)
]) streamDeck.actions.registerAction(pluginAction);

streamDeck.connect();
void controller.start().catch((error) => streamDeck.logger.error(`Codex-Verbindung fehlgeschlagen: ${String(error)}`));

process.once("SIGTERM", () => controller.stop());
process.once("SIGINT", () => controller.stop());
