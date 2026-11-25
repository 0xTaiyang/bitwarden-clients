import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

describe("SSH approval popup keyboard shortcuts", () => {
  let keydown: (event: KeyboardEvent) => void;
  let answer: jest.Mock;
  let buttons: Record<string, { disabled: boolean; addEventListener: jest.Mock }>;

  beforeEach(() => {
    answer = jest.fn().mockResolvedValue(undefined);
    buttons = {
      authorize: { disabled: false, addEventListener: jest.fn() },
      deny: { disabled: false, addEventListener: jest.fn() },
    };
    runInNewContext(readFileSync(join(__dirname, "ssh-approval.js"), "utf8"), {
      document: { getElementById: (id: string) => buttons[id] ?? {} },
      window: {
        ipc: {
          platform: {
            // Keep request loading pending; only keyboard handling is under test.
            getSshApprovalWindowRequest: () => new Promise(() => {}),
            answerSshApprovalWindow: answer,
          },
        },
        addEventListener: (_type: string, handler: typeof keydown) => (keydown = handler),
      },
    });
  });

  it("authorizes with Enter even when Deny has focus, preventing its default click", () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    Object.defineProperty(event, "target", { value: buttons.deny });
    keydown(event);

    expect(event.defaultPrevented).toBe(true);
    expect(answer).toHaveBeenCalledWith(true);
    expect(buttons.authorize.disabled).toBe(true);
    expect(buttons.deny.disabled).toBe(true);
  });

  it("denies with Escape", () => {
    keydown(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(answer).toHaveBeenCalledWith(false);
  });

  it("answers only once across repeated key presses", () => {
    keydown(new KeyboardEvent("keydown", { key: "Enter" }));
    keydown(new KeyboardEvent("keydown", { key: "Enter" }));
    keydown(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it.each([{ repeat: true }, { isComposing: true }])("ignores Enter with %o", (options) => {
    keydown(new KeyboardEvent("keydown", { key: "Enter", ...options }));
    expect(answer).not.toHaveBeenCalled();
  });
});
