/**
 * Hidden input element for mobile seed entry via virtual keyboard.
 *
 * Creates a visually hidden <input> that captures numeric input on
 * touch devices, syncing the typed value back to the caller via onInput.
 */

export interface SeedField {
  focus: (currentValue: string) => void;
  blur: () => void;
}

export function createSeedField(
  maxLength: number,
  onInput: (digits: string) => void,
): SeedField {
  let element: HTMLInputElement | undefined;

  function ensure(): HTMLInputElement {
    if (element) return element;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.pattern = "[0-9]*";
    input.maxLength = maxLength;
    input.autocomplete = "off";
    Object.assign(input.style, {
      position: "fixed",
      top: "0",
      left: "0",
      opacity: "0",
      width: "1px",
      height: "1px",
      border: "none",
      padding: "0",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "").slice(0, maxLength);
      input.value = digits;
      onInput(digits);
    });
    document.body.appendChild(input);
    element = input;
    return input;
  }

  return {
    focus(currentValue: string) {
      const input = ensure();
      input.value = currentValue;
      input.focus({ preventScroll: true });
    },
    blur() {
      element?.blur();
    },
  };
}
