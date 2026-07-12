import { flexRender, type Table } from "@tanstack/react-table";
import { cn } from "./cn";

export type DataTableProps<TData> = {
  table: Table<TData>;
  compact?: boolean;
  testId?: string;
  onRowClick?: (row: TData) => void;
  isRowClickable?: (row: TData) => boolean;
};

export function DataTable<TData>({ table, compact = false, testId, onRowClick, isRowClickable }: DataTableProps<TData>) {
  const padding = compact ? "px-3 py-2" : "px-4 py-3";
  return <div data-testid={testId} className="overflow-hidden rounded-md border border-border/60 bg-surface shadow-ambient"><div className="overflow-x-auto overflow-y-hidden"><table className="min-w-full border-collapse"><thead className="border-b border-subtle bg-surface-low">{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id} className={cn("text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-tertiary", padding)}>{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map((row) => {
    const data = row.original;
    const clickable = Boolean(onRowClick) && (isRowClickable ? isRowClickable(data) : true);
    return <tr key={row.id} tabIndex={clickable ? 0 : undefined} data-testid={testId ? `${testId}__row` : undefined} data-row-id={typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" ? data.id : undefined} onClick={clickable ? () => onRowClick?.(data) : undefined} onKeyDown={clickable ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRowClick?.(data); } } : undefined} className={cn("border-b border-subtle last:border-b-0 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/20", clickable && "cursor-pointer", row.getIsSelected() ? "bg-surface-high text-foreground" : "hover:bg-surface-low")}>{row.getVisibleCells().map((cell) => <td key={cell.id} className={cn("text-sm text-primary", padding)}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>;
  })}</tbody></table></div></div>;
}
