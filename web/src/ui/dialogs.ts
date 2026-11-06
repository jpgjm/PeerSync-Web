/**
 * Confirmation and notice dialogs (instead of the browser's confirm() / alert()). Material Web's md-dialog.
 *
 * Why not the built-in dialogs:
 *  - Safari offers "Don't show dialogs" from the second confirm()/alert(). If tapped by mistake, confirm()
 *    returns false without showing anything, and actions like unpairing silently stop working
 *  - their look and button names can't match the app ("Unpair" instead of "OK")
 *
 * md-dialog uses <dialog>.showModal(), so the browser disables the background, traps focus, closes on Esc and
 * returns focus to the previous element.
 */
import type { MdDialog } from "@material/web/dialog/dialog.js";

let seq = 0;

export interface ConfirmOptions {
  title: string;
  body?: string;
  /** Confirm button label. Name the action ("Unpair", not "OK"). */
  confirmLabel: string;
  cancelLabel?: string;
  /** critical: can't be undone. The confirm button uses the error color and focus starts on Cancel. */
  tone?: "primary" | "critical";
}

/** Confirmation dialog. true if confirmed; Esc, a scrim tap and Cancel give false. */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  const critical = (o.tone ?? "primary") === "critical";
  return open({
    title: o.title,
    body: o.body,
    buttons: [
      { value: "cancel", label: o.cancelLabel ?? "Cancel", critical: false, autofocus: critical },
      { value: "ok", label: o.confirmLabel, critical, autofocus: !critical },
    ],
  }).then((v) => v === "ok");
}

/** Notice (one button). Resolves when closed. */
export function noticeDialog(o: { title: string; body?: string; okLabel?: string }): Promise<void> {
  return open({
    title: o.title,
    body: o.body,
    buttons: [{ value: "ok", label: o.okLabel ?? "OK", critical: false, autofocus: true }],
  }).then(() => undefined);
}

interface OpenOptions {
  title: string;
  body?: string;
  buttons: { value: string; label: string; critical: boolean; autofocus: boolean }[];
}

function open(o: OpenOptions): Promise<string> {
  const id = `dlg-${++seq}`;
  const dialog = document.createElement("md-dialog") as MdDialog;
  dialog.type = "alert";

  const headline = document.createElement("div");
  headline.slot = "headline";
  headline.textContent = o.title;
  dialog.appendChild(headline);

  const form = document.createElement("form");
  form.slot = "content";
  form.id = `${id}-form`;
  form.method = "dialog";
  if (o.body) {
    const p = document.createElement("p");
    p.className = "dialog-body";
    p.textContent = o.body;
    form.appendChild(p);
  }
  dialog.appendChild(form);

  const actions = document.createElement("div");
  actions.slot = "actions";
  for (const b of o.buttons) {
    const btn = document.createElement("md-text-button");
    btn.setAttribute("form", form.id);
    btn.setAttribute("value", b.value);
    btn.textContent = b.label;
    if (b.critical) btn.className = "critical";
    if (b.autofocus) btn.setAttribute("autofocus", "");
    actions.appendChild(btn);
  }
  dialog.appendChild(actions);
  document.body.appendChild(dialog);

  return new Promise((resolve) => {
    dialog.addEventListener(
      "closed",
      () => {
        resolve(dialog.returnValue || "cancel");
        dialog.remove();
      },
      { once: true },
    );
    void dialog.show();
  });
}
