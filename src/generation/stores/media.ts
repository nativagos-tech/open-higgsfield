import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { MediaItem } from "../catalog/types";
import { browserStorage } from "./browser-storage";

type MediaState = {
  items: MediaItem[];
  add: (item: MediaItem) => void;
  remove: (id: string) => void;
  /** Re-seat an item inside its own role: directly in front of `before`, or
      last when `before` is null. */
  move: (id: string, before: string | null) => void;
};

/** The items with `id` moved in front of `before` — or to the end of its role
    when `before` is null — among the items that share its role.

    A reorder is only ever a reorder *within* a role. The platform receives each
    role as its own ordered list and a prompt points at a frame by the number
    that order gives it, so the order across roles is not something the platform
    is ever told; rows of other roles keep the places they had. */
export function moveMediaItem(items: MediaItem[], id: string, before: string | null): MediaItem[] {
  const moved = items.find((item) => item.id === id);
  if (!moved) return items;

  const rest = items.filter((item) => item.role === moved.role && item.id !== id);
  const at = before === null ? rest.length : rest.findIndex((item) => item.id === before);
  const from = items.filter((item) => item.role === moved.role).indexOf(moved);
  /* Already standing where it was asked to stand: handing back the same array
     keeps a drag that is resting still from re-rendering the strip under it. */
  if (at < 0 || at === from) return items;

  rest.splice(at, 0, moved);
  let next = 0;
  return items.map((item) => (item.role === moved.role ? rest[next++]! : item));
}

function createMediaStore(name: string) {
  return create<MediaState>()(
    persist(
      (set) => ({
        items: [],
        add: (item) => set((state) => ({ items: [...state.items, item] })),
        remove: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
        move: (id, before) =>
          set((state) => {
            const items = moveMediaItem(state.items, id, before);
            return items === state.items ? state : { items };
          }),
      }),
      {
        name,
        storage: browserStorage(),
        partialize: (state) => ({
          items: state.items.filter((item) => !item.url.startsWith("blob:")),
        }),
      },
    ),
  );
}

export const useImageMedia = createMediaStore("openhiggsfield.imageMedia.v1");
export const useVideoMedia = createMediaStore("openhiggsfield.videoMedia.v1");
