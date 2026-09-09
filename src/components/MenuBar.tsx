import { useEffect, useRef, useState, type ReactNode } from "react";

export type MenuItemDef =
  | { type: "sep" }
  | {
      type: "item";
      label: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      /** Optional sub content (e.g. recent files); expands on click/hover. */
      children?: (close: () => void) => ReactNode;
      /** Optional; items with `children` may omit a direct action. */
      onAction?: () => void;
    };

export interface MenuGroupDef {
  key: string;
  label: string;
  items: MenuItemDef[];
}

/** Menu groups (文件 / 编辑 / 帮助 …). Horizontal top-bar usage or, with
 * `vertical`, a column whose items open their command lists to the right
 * (used by the logo dropdown). An item click runs its action and closes. */
export function MenuBar({
  groups,
  onItemAction,
  vertical = false,
}: {
  groups: MenuGroupDef[];
  /** Called after any menu item action runs (lets an outer popover close). */
  onItemAction?: () => void;
  /** Render the group labels vertically with right-side submenus. */
  vertical?: boolean;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelCloseGroups = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleCloseGroups = () => {
    cancelCloseGroups();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpenKey(null);
    }, 180); // grace for moving the pointer across the gap into a submenu
  };

  const openGroup = (key: string) => {
    cancelCloseGroups();
    setOpenKey(key);
  };

  useEffect(() => {
    return () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!openKey) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpenKey(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenKey(null);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openKey]);

  const close = () => setOpenKey(null);

  return (
    <div
      className={`menubar ${vertical ? "menubar-v" : ""}`}
      ref={barRef}
      onMouseLeave={vertical ? scheduleCloseGroups : undefined}
    >
      {groups.map((g) => (
        <div className="menu" key={g.key}>
          <button
            className={`menu-trigger ${vertical ? "menu-trigger-v" : ""} ${openKey === g.key ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (openKey === g.key) close();
              else openGroup(g.key);
            }}
            onMouseEnter={() => {
              // Hovering a first-level item opens its submenu to the right
              // and switches when another item is open.
              openGroup(g.key);
            }}
          >
            <span className="menu-trigger-label">{g.label}</span>
            {vertical && (
              <span className="menu-v-caret" aria-hidden="true">
                ›
              </span>
            )}
          </button>
          {openKey === g.key && (
            <div
              className={`menu-panel ${vertical ? "menu-panel-right" : ""}`}
              role="menu"
              onMouseEnter={vertical ? cancelCloseGroups : undefined}
            >
              {g.items.map((item, i) => (
                <MenuRow key={i} item={item} close={close} onItemAction={onItemAction} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MenuRow({
  item,
  close,
  onItemAction,
}: {
  item: MenuItemDef;
  close: () => void;
  onItemAction?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Closing is delayed briefly so the cursor can travel from the parent item
  // across the small gap into the submenu without it vanishing.
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  const cancelClose = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };

  const openNow = () => {
    cancelClose();
    setOpen(true);
  };

  if (item.type === "sep") return <div className="menu-sep" />;

  const hasChildren = Boolean(item.children);
  const fire = () => {
    if (item.disabled) return;
    if (item.onAction) {
      close();
      item.onAction();
      onItemAction?.();
    } else if (hasChildren) {
      setOpen((o) => !o);
    }
  };

  return (
    <div
      className={`menu-item ${item.disabled ? "disabled" : ""} ${item.danger ? "danger" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        fire();
      }}
      onMouseEnter={() => {
        if (hasChildren) openNow();
        else cancelClose();
      }}
      onMouseLeave={() => {
        if (hasChildren) scheduleClose();
        else cancelClose();
      }}
    >
      <span className="menu-item-label">{item.label}</span>
      {item.shortcut && <span className="menu-item-shortcut">{item.shortcut}</span>}
      {hasChildren && (
        <span className="menu-caret" aria-hidden="true">
          ›
        </span>
      )}
      {open && hasChildren && (
        <div
          className="menu-panel submenu"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
        >
          {item.children?.(close)}
        </div>
      )}
    </div>
  );
}

/** Convenience: recent-file style body with a scrolling list of buttons. */
export function menuChildList(items: Array<{ label: string; onClick: () => void }>) {
  return (close: () => void) => (
    <div className="menu-child-list">
      {items.length === 0 ? (
        <div className="menu-child-empty">（空）</div>
      ) : (
        items.map((it) => (
          <button
            key={it.label}
            className="menu-child-btn"
            onClick={(e) => {
              e.stopPropagation();
              close();
              it.onClick();
            }}
            title={it.label}
          >
            {it.label}
          </button>
        ))
      )}
    </div>
  );
}
