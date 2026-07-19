export type ToastType = "success" | "error" | "warning" | "info";
export type ToastMessage = { id: string; type: ToastType; message: string; duration: number };

export function appendToast(messages: ToastMessage[], next: ToastMessage): ToastMessage[] {
  const retained = next.type === "success"
    ? messages.filter((message) => message.type !== "success")
    : messages;
  return [...retained, next];
}
