"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { MediaItem, MediaRole, ModelEntry } from "@/generation/catalog";
import { useImageMedia, useVideoMedia } from "@/generation/stores/media";
import { uploadMedia } from "@/generation/upload";

import { ROLE_ACCEPT, ROLE_LABELS, ROLE_TAGS, rolesOf } from "./data";
import { AudioIcon, CloseIcon, GripIcon, VideoIcon } from "./icons";
import { dropBefore, type TileBox } from "./reorder";
import { kindOfFile, loadUploads, mergeUploads, rememberUpload, saveUploads, type UploadRecord } from "./uploads";

/** How far a press has to travel before it counts as a drag: a press that ends
    where it began is not a reorder. */
const DRAG_SLOP = 4;

function useMedia(model: ModelEntry) {
  const imageMedia = useImageMedia();
  const videoMedia = useVideoMedia();
  return model.surface === "image" ? imageMedia : videoMedia;
}

export interface MediaTray {
  roles: MediaRole[];
  /** The current surface's attachments, so the picker can derive its own caps
      from the same list the strip below renders. */
  items: MediaItem[];
  /** Every file this browser has sent to Blob, newest first. */
  uploads: UploadRecord[];
  /** The URL of the last file uploaded from the picker. It goes onto the shelf
      and into the panel's selection, not onto the plane — the panel stages the
      whole set and one press applies it. */
  staged: string | null;
  uploading: boolean;
  allFull: boolean;
  /** Hidden file input; render it once inside the composer. */
  input: ReactNode;
  /** Set the role the next file takes, then open the OS picker. */
  begin: (role: MediaRole) => void;
  /** Make the role's inputs exactly these URLs — the picker hands back the set
      it edited, so one press both attaches and detaches. */
  apply: (role: MediaRole, urls: string[]) => void;
}

export function useMediaTray(
  model: ModelEntry,
  onError: (message: string | null) => void,
): MediaTray {
  const media = useMedia(model);
  const [uploading, setUploading] = useState(false);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [staged, setStaged] = useState<string | null>(null);
  const [uploadsLoaded, setUploadsLoaded] = useState(false);
  const roleRef = useRef<MediaRole>("reference");
  const inputRef = useRef<HTMLInputElement>(null);

  /* Read once, then write back on every change — the same order history takes,
     and for the same reason: writing before the read has landed would persist
     the empty initial value over the stored shelf. */
  useEffect(() => {
    let live = true;
    void loadUploads()
      .then((rows) => {
        if (!live) return;
        setUploads((current) => mergeUploads(rows, current));
        setUploadsLoaded(true);
      })
      .catch(() => {
        if (live) setUploadsLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (uploadsLoaded) void saveUploads(uploads);
  }, [uploadsLoaded, uploads]);

  const roles = rolesOf(model);
  const counts: Record<string, number> = {};
  for (const role of roles) {
    counts[role] = media.items.filter((item) => item.role === role).length;
  }
  const allFull = roles.length > 0 && roles.every((role) => counts[role]! >= (model.roles[role] ?? 0));

  async function onFile(file: File | undefined) {
    if (!file) return;
    onError(null);
    setUploading(true);
    try {
      const uploaded = await uploadMedia(file);
      /* The file outlives this run: it joins the shelf the picker offers, so a
         reference used once can be reached again without a second upload. */
      setStaged(uploaded.url);
      setUploads((prev) =>
        rememberUpload(prev, {
          id: crypto.randomUUID(),
          url: uploaded.url,
          kind: kindOfFile(file),
          name: file.name,
          createdAt: Date.now(),
        }),
      );
    } catch (caught) {
      onError(
        caught instanceof Error
          ? `Upload failed — ${caught.message}. Check the Blob store is configured, then retry.`
          : "Upload failed. Retry, or drop the file and generate from the prompt alone.",
      );
    } finally {
      setUploading(false);
    }
  }

  /* accept is set on the element rather than through state: the picker opens in
     the same tick as the choice, before React could re-render it. */
  function begin(role: MediaRole) {
    const element = inputRef.current;
    if (!element) return;
    roleRef.current = role;
    element.accept = ROLE_ACCEPT[role];
    element.click();
  }

  const input = (
    <input
      ref={inputRef}
      type="file"
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        void onFile(file);
      }}
    />
  );

  /* A replace, not an append: the panel edits one role's whole set, so what it
     hands back decides both what arrives and what leaves. Rows whose URL
     survives keep their id, and with it their place in the strip. */
  function apply(role: MediaRole, urls: string[]) {
    const keep = new Set(urls);
    const held = new Set<string>();
    for (const item of media.items) {
      if (item.role !== role) continue;
      if (keep.has(item.url)) held.add(item.url);
      else media.remove(item.id);
    }
    for (const url of urls) {
      if (!held.has(url)) media.add({ id: crypto.randomUUID(), url, role });
    }
  }

  return { roles, items: media.items, uploads, staged, uploading, allFull, input, begin, apply };
}

/** Attached inputs, above the prompt — the frames read before the words do. */
export function MediaStrip({ model }: { model: ModelEntry }) {
  const media = useMedia(model);
  const items = media.items.filter((item) => model.roles[item.role]);

  /* Reordering is two gestures with one outcome. The pointer picks a tile up and
     puts it down where it lets go; the keyboard lifts a tile with its grip and
     walks it through its own role with the arrow keys. `lifted` is that one tile
     off the strip, and `note` is the move said out loud — the order is the whole
     point of the gesture and a screen reader cannot see it change. */
  const [lifted, setLifted] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const gesture = useRef<{ id: string; dragging: boolean } | null>(null);
  /* Raised while a move is about to happen under the grip's own focus. A
     reorder re-inserts the tile's node, and a node that is re-inserted drops the
     focus it held — so the blur that follows is our doing, not the visitor
     letting go, and the grip takes the focus back. */
  const moving = useRef(false);
  /* The strip as of the last commit. A drag starts on a tile and ends on the
     window, so the listener that ends it can be a render or two behind the
     order it has been rearranging. */
  const rows = useRef(items);
  /* How the gesture in flight takes itself off the window. */
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => () => detach.current?.(), []);

  useLayoutEffect(() => {
    rows.current = items;
    if (!moving.current) return;
    moving.current = false;
    if (lifted) grips.current.get(lifted)?.focus();
  }, [items, lifted]);

  if (items.length === 0) return null;

  const counts: Partial<Record<MediaRole, number>> = {};
  for (const item of items) counts[item.role] = (counts[item.role] ?? 0) + 1;

  /* The platform gets each role as an ordered list, and the prompt can only
     point at an image by its position — so a role that takes several shows the
     number the model will know it by, and is the only kind of role whose tiles
     can be moved: a start frame alone in its role has no order to change. */
  const seen: Partial<Record<MediaRole, number>> = {};
  const numbered = items.map((item) => {
    const position = (seen[item.role] ?? 0) + 1;
    seen[item.role] = position;
    const several = (model.roles[item.role] ?? 0) > 1;
    return {
      item,
      position,
      index: several ? position : null,
      movable: several && (counts[item.role] ?? 0) > 1,
    };
  });

  /** "Reference 2 of 4" — the tile as the platform and the prompt count it. */
  function phrase(item: MediaItem): string {
    const roster = rows.current.filter((row) => row.role === item.role);
    const at = roster.findIndex((row) => row.id === item.id) + 1;
    return `${ROLE_LABELS[item.role]} ${at} of ${roster.length}`;
  }

  /** Every tile's box, in the order they are laid out. Read as the pointer
      moves rather than cached, because a reorder is precisely the strip
      changing under the drag. */
  function boxes(): TileBox[] {
    const list = listRef.current;
    if (!list) return [];
    const out: TileBox[] = [];
    for (const node of list.querySelectorAll<HTMLElement>("li[data-media-id]")) {
      const box = node.getBoundingClientRect();
      out.push({
        id: node.dataset.mediaId ?? "",
        role: node.dataset.role as MediaRole,
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      });
    }
    return out;
  }

  function down(event: ReactPointerEvent<HTMLLIElement>, item: MediaItem) {
    /* The remove button sits on the tile and is a control of its own. */
    if (event.button !== 0 || (event.target as HTMLElement).closest(".ohf-strip-remove")) return;

    const pointerId = event.pointerId;
    const origin = { x: event.clientX, y: event.clientY };
    const held = { id: item.id, dragging: false };
    /* One gesture at a time: a drag whose release never arrived — the pointer
       let go outside the window — would otherwise still be listening for the
       next one, and this pointer id is the same hand. */
    detach.current?.();
    gesture.current = held;

    function detachAll() {
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      detach.current = null;
      /* Whatever the drag turned off, the page turns back on. */
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("-webkit-user-select");
    }

    /* The drag is followed on the window, not on the tile. The tile changes
       place in the strip as it goes — that is what dragging it means — and a
       listener bound to the node travels with it, or stops hearing the pointer
       once the node has been re-inserted. */
    function follow(event: PointerEvent) {
      if (event.pointerId !== pointerId) return;
      if (!held.dragging) {
        /* Nothing moves until the pointer has travelled: a press that ends
           where it began is not a reorder. */
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_SLOP) return;
        held.dragging = true;
        /* A drag that crosses the composer must not paint a text selection
           behind it; the strip is not a text surface and the browser has no way
           to know that. */
        document.body.style.setProperty("user-select", "none");
        document.body.style.setProperty("-webkit-user-select", "none");
        window.getSelection()?.removeAllRanges();
        setLifted(item.id);
      }
      media.move(item.id, dropBefore(boxes(), item.id, event.clientX, event.clientY));
    }

    /* A reorder is committed as it is dragged, never on release: the pointer
       letting go — or the browser taking the gesture away for a scroll — only
       puts the tile back down. */
    function release(event: PointerEvent) {
      if (event.pointerId !== pointerId) return;
      detachAll();
      gesture.current = null;
      if (!held.dragging) return;
      setLifted(null);
      setNote(`${phrase(item)}.`);
    }

    detach.current = detachAll;
    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }

  /** Leaving the grip sets the tile down — unless the tile moved under the
      focus, which the layout effect above is already about to take back. */
  function blurred() {
    if (moving.current || gesture.current?.dragging) return;
    setLifted(null);
  }

  function keyed(event: ReactKeyboardEvent<HTMLButtonElement>, item: MediaItem) {
    const key = event.key;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      setLifted(lifted === item.id ? null : item.id);
      setNote(
        lifted === item.id
          ? `${phrase(item)}, set down.`
          : `${phrase(item)} lifted. Arrow keys move it, Enter or Escape sets it down.`,
      );
      return;
    }
    if (key === "Escape") {
      if (lifted !== item.id) return;
      event.preventDefault();
      setLifted(null);
      setNote(`${phrase(item)}, set down.`);
      return;
    }

    const roster = items.filter((row) => row.role === item.role);
    const rest = roster.filter((row) => row.id !== item.id);
    const at = roster.findIndex((row) => row.id === item.id);
    const step =
      key === "ArrowLeft" || key === "ArrowUp" ? -1 : key === "ArrowRight" || key === "ArrowDown" ? 1 : 0;
    const target =
      key === "Home" ? 0 : key === "End" ? rest.length : step === 0 ? null : Math.max(0, Math.min(rest.length, at + step));
    if (target === null) return;

    event.preventDefault();
    /* Reaching for the arrows means moving the tile, whether it was lifted
       first or not. */
    setLifted(item.id);
    if (target !== at) {
      moving.current = true;
      media.move(item.id, rest[target]?.id ?? null);
    }
    setNote(`${ROLE_LABELS[item.role]} ${target + 1} of ${roster.length}.`);
  }

  return (
    <>
      <ul className="ohf-strip" ref={listRef}>
        {numbered.map(({ item, position, index, movable }) => (
          <li
            key={item.id}
            className="ohf-strip-item"
            data-media-id={item.id}
            data-role={item.role}
            data-reorder={movable ? "true" : undefined}
            data-lifted={lifted === item.id ? "true" : undefined}
            onPointerDown={movable ? (event) => down(event, item) : undefined}
          >
            <span className="ohf-strip-tile">
              {item.role === "audio" || item.role === "video" ? (
                <span className="ohf-strip-glyph">
                  {item.role === "audio" ? <AudioIcon size={20} /> : <VideoIcon size={20} />}
                </span>
              ) : (
                /* Blob-hosted user upload; next/image would proxy an arbitrary
                   remote host for a 56px thumb. Not draggable: the pointer drag
                   that reorders the tile is the only drag here, and a native
                   image drag would take the gesture away from it. */
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  className="ohf-strip-thumb"
                  src={item.url}
                  alt=""
                  draggable={false}
                  onError={(event) => {
                    event.currentTarget.style.visibility = "hidden";
                  }}
                />
              )}
              <span className="ohf-strip-tag">
                {ROLE_TAGS[item.role]}
                {index !== null && <span className="ohf-strip-num">{index}</span>}
              </span>
            </span>
            {movable && (
              <button
                ref={(node) => {
                  if (node) grips.current.set(item.id, node);
                  else grips.current.delete(item.id);
                }}
                type="button"
                className="ohf-strip-grip"
                aria-label={`Reorder ${ROLE_LABELS[item.role].toLowerCase()} ${position} of ${
                  counts[item.role] ?? 0
                }: press Enter to lift it, the arrow keys to move it`}
                onKeyDown={(event) => keyed(event, item)}
                onBlur={blurred}
              >
                <GripIcon size={12} />
              </button>
            )}
            <button
              type="button"
              className="ohf-strip-remove"
              aria-label={`Remove ${ROLE_LABELS[item.role].toLowerCase()}${index !== null ? ` ${index}` : ""}`}
              onClick={() => media.remove(item.id)}
            >
              <CloseIcon size={10} />
            </button>
          </li>
        ))}
      </ul>
      <p className="ohf-sr" role="status">
        {note}
      </p>
    </>
  );
}
