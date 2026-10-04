import {
  action,
  type DialDownEvent,
  type DialRotateEvent,
  type DialUpEvent,
  type DidReceiveSettingsEvent,
  type PropertyInspectorDidAppearEvent,
  type PropertyInspectorDidDisappearEvent,
  type SendToPluginEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import type { DeckController } from "./controller.js";
import type { CodexDialSettings } from "./dial-types.js";

@action({ UUID: "com.simeo.codex-deck.codex-dial" })
export class CodexDialAction extends SingletonAction<CodexDialSettings> {
  constructor(private readonly controller: DeckController) { super(); }

  override onWillAppear(ev: WillAppearEvent<CodexDialSettings>): void {
    if (ev.action.isDial()) this.controller.registerDial(ev.action, ev.payload.settings);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<CodexDialSettings>): void {
    if (ev.action.isDial()) this.controller.updateDialSettings(ev.action, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<CodexDialSettings>): void {
    this.controller.unregisterDial(ev.action);
  }

  override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<CodexDialSettings>): void {
    if (ev.action.isDial()) this.controller.registerDialPropertyInspector(ev.action);
  }

  override onPropertyInspectorDidDisappear(ev: PropertyInspectorDidDisappearEvent<CodexDialSettings>): void {
    if (ev.action.isDial()) this.controller.unregisterDialPropertyInspector(ev.action);
  }

  override onSendToPlugin(ev: SendToPluginEvent<JsonValue, CodexDialSettings>): void {
    if (ev.action.isDial()) this.controller.handleDialPropertyInspectorMessage(ev.action, ev.payload);
  }

  override onDialRotate(ev: DialRotateEvent<CodexDialSettings>): void {
    this.controller.rotateDial(ev.action, ev.payload.ticks);
  }

  override async onDialDown(ev: DialDownEvent<CodexDialSettings>): Promise<void> {
    await this.controller.beginDialPress(ev.action);
  }

  override async onDialUp(ev: DialUpEvent<CodexDialSettings>): Promise<void> {
    await this.controller.finishDialPress(ev.action);
  }

  override async onTouchTap(ev: TouchTapEvent<CodexDialSettings>): Promise<void> {
    if (!ev.payload.hold) await this.controller.touchDial(ev.action);
  }
}
