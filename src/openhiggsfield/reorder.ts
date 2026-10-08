import type { MediaRole } from "@/generation/catalog";

/** A tile as the pointer sees it: which item it holds, which role it fills, and
    the box it currently occupies in viewport coordinates. */
export interface TileBox {
  id: string;
  role: MediaRole;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The tile the dragged one should be placed in front of, given where the
    pointer is — or null when the pointer is past the last of its role, which
    lands it at the end.

    Only the tiles sharing the dragged tile's role count. The strip is a single
    run of tiles that carries every role at once, but the order that reaches the
    platform is per role — so a start frame standing between two references is
    not a place a reference can be dropped. */
export function dropBefore(boxes: TileBox[], dragId: string, x: number, y: number): string | null {
  const dragged = boxes.find((box) => box.id === dragId);
  if (!dragged) return null;

  for (const box of boxes) {
    if (box.id === dragId || box.role !== dragged.role) continue;
    if (!behind(box, x, y)) return box.id;
  }
  return null;
}

/** Whether the pointer has travelled past a tile, read in the order the tiles
    are laid out: a row above the pointer is behind it, a row below is still
    ahead, and in the pointer's own row the tile's middle is the line. The strip
    wraps, so a single line on x would call tiles on the next row passed while
    the pointer is still crossing the first. */
function behind(box: TileBox, x: number, y: number): boolean {
  if (y > box.bottom) return true;
  if (y < box.top) return false;
  return x > (box.left + box.right) / 2;
}
