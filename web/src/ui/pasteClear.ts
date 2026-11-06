/**
 * Trailing button of a text field (like the app's PasteClearButton, 0.2.37): one button whose role follows the input.
 *   empty     -> Paste (fills the field from the clipboard)
 *   not empty -> Clear (empties the field)
 * When Paste finds no text, the field's supporting text says "The clipboard is empty." until the text changes
 * (a snackbar would be hidden behind the dialog). If the browser refuses to read the clipboard, it says so there.
 */
import type { MdOutlinedTextField } from "@material/web/textfield/outlined-text-field.js";
import type { MdIconButton } from "@material/web/iconbutton/icon-button.js";
import { setIcon } from "./md";

export const PASTE = "Paste";
export const CLEAR = "Clear";
export const CLIPBOARD_EMPTY = "The clipboard is empty.";
export const CLIPBOARD_DENIED = "Couldn't read the clipboard (the browser didn't allow it).";

export interface PasteClear {
  /**
   * Updates the button after the value was set from code (field.value = …) and clears the hints.
   * supporting replaces the field's normal supporting text (for a field reused by several dialogs).
   */
  refresh(supporting?: string): void;
  /** Shows an error under the field (null clears it). The clipboard hints are shown only without an error. */
  setError(message: string | null): void;
}

export function attachPasteClear(
  field: MdOutlinedTextField,
  log: (msg: string) => void,
  onChange: () => void = () => {},
): PasteClear {
  const button = document.createElement("md-icon-button") as MdIconButton;
  button.slot = "trailing-icon";
  button.type = "button";
  const icon = document.createElement("md-icon");
  button.appendChild(icon);
  field.appendChild(button);

  let baseSupporting = field.supportingText;
  let hint: string | null = null;
  let error: string | null = null;

  const render = () => {
    const empty = field.value.length === 0;
    const label = empty ? PASTE : CLEAR;
    setIcon(icon, empty ? "contentPaste" : "close");
    button.title = label;
    button.ariaLabel = label;
    field.error = error !== null;
    field.errorText = error ?? "";
    field.supportingText = error === null && hint !== null ? hint : baseSupporting;
  };

  field.addEventListener("input", () => {
    hint = null;
    render();
    onChange();
  });

  button.addEventListener("click", async (e) => {
    e.preventDefault(); // inside a <form method="dialog">: don't submit
    if (field.value.length > 0) {
      log("input: clear");
      field.value = "";
      hint = null;
      render();
      onChange();
      field.focus();
      return;
    }
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      log(`input: paste failed (${err instanceof Error ? err.message : err})`);
      hint = CLIPBOARD_DENIED;
      render();
      return;
    }
    if (!text) {
      log("input: paste, clipboard is empty");
      hint = CLIPBOARD_EMPTY;
      render();
      return;
    }
    log(`input: paste ${text.length} chars`);
    field.value = text;
    hint = null;
    render();
    onChange();
    field.focus();
  });

  render();
  return {
    refresh: (supporting) => {
      if (supporting !== undefined) baseSupporting = supporting;
      hint = null;
      error = null;
      render();
    },
    setError: (m) => {
      error = m;
      render();
    },
  };
}
