import { map } from "rxjs";

import {
  AUTOFILL_SETTINGS_DISK,
  KeyDefinition,
  StateProvider,
} from "@bitwarden/common/platform/state";

const ENABLE_DUCK_DUCK_GO_BROWSER_INTEGRATION = new KeyDefinition(
  AUTOFILL_SETTINGS_DISK,
  "enableDuckDuckGoBrowserIntegration",
  {
    deserializer: (v: boolean) => v,
  },
);

const SSH_AGENT_BARK_URL = new KeyDefinition<string>(AUTOFILL_SETTINGS_DISK, "sshAgentBarkUrl", {
  deserializer: (value) => value,
});

const SSH_AGENT_BARK_WAIT_FOR_MAC = new KeyDefinition<boolean>(
  AUTOFILL_SETTINGS_DISK,
  "sshAgentBarkWaitForMac",
  { deserializer: (value) => value },
);

export class DesktopAutofillSettingsService {
  private readonly sshAgentBarkUrlState = this.stateProvider.getGlobal(SSH_AGENT_BARK_URL);
  readonly sshAgentBarkUrl$ = this.sshAgentBarkUrlState.state$.pipe(map((value) => value ?? ""));
  private readonly sshAgentBarkWaitForMacState = this.stateProvider.getGlobal(
    SSH_AGENT_BARK_WAIT_FOR_MAC,
  );
  readonly sshAgentBarkWaitForMac$ = this.sshAgentBarkWaitForMacState.state$.pipe(
    map((value) => value ?? true),
  );

  private enableDuckDuckGoBrowserIntegrationState = this.stateProvider.getGlobal(
    ENABLE_DUCK_DUCK_GO_BROWSER_INTEGRATION,
  );
  enableDuckDuckGoBrowserIntegration$ = this.enableDuckDuckGoBrowserIntegrationState.state$.pipe(
    map((x) => x ?? false),
  );

  constructor(private stateProvider: StateProvider) {}

  async setSshAgentBarkUrl(value: string): Promise<void> {
    await this.sshAgentBarkUrlState.update(() => value.trim());
  }

  async setSshAgentBarkWaitForMac(value: boolean): Promise<void> {
    await this.sshAgentBarkWaitForMacState.update(() => value);
  }

  async setEnableDuckDuckGoBrowserIntegration(newValue: boolean): Promise<void> {
    await this.enableDuckDuckGoBrowserIntegrationState.update(() => newValue);
  }
}
