import { Check } from "lucide-react";
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn";

export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(function Checkbox({ className, ...props }, ref) { return <span className="relative inline-grid size-4 shrink-0 place-items-center"><input ref={ref} type="checkbox" className={cn("peer size-4 appearance-none rounded-sm border border-border-input/80 bg-input transition-colors duration-150 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 checked:border-accent checked:bg-accent", className)} {...props} /><Check aria-hidden className="pointer-events-none absolute size-3 text-white opacity-0 peer-checked:opacity-100" /></span>; });
