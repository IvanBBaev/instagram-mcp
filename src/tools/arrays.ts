/**
 * Item-count bounds for array arguments (Layer 3).
 *
 * zod 4 runs a length check on any value that has a `length` — not only on a
 * value of the declared type — even after the type check has already refused it
 * (`_whenHasLength` in `zod/v4/core/checks`). So `z.array(…).max(10)` handed the
 * single string a model most often sends by mistake
 * (`imageUrls: "https://…/a.jpg"`) reported a second issue next to the right one:
 *
 *   imageUrls: Invalid input: expected array, received string,
 *   imageUrls: Too big: expected string to have <=10 characters
 *
 * The second line reads as a rule about the URL's length and points the model at
 * the wrong fix. zod 3 stopped at the type error (CC-PUB-67).
 *
 * The checks below are the same `min_length` / `max_length` checks `.min()` /
 * `.max()` build — same issues, same messages, same `minItems` / `maxItems` in
 * the published JSON Schema — with their `when` gate narrowed to an actual
 * array. `.min()` / `.max()` do not accept `when`, so the checks are built
 * directly from the core classes.
 */
import { z } from 'zod';

/** Run an item-count check only when the value really is an array. */
const onArray = (payload: { value: unknown }): boolean => Array.isArray(payload.value);

/**
 * `z.array(item)` holding `min`..`max` items, whose count is checked only once
 * the value is known to be an array (CC-PUB-67). Chain `.optional()` /
 * `.describe()` at the call site as with a plain `z.array()`.
 */
export function boundedArray<T extends z.ZodType>(
  item: T,
  min: number,
  max?: number,
): z.ZodArray<T> {
  const checks: z.core.$ZodCheck<unknown[]>[] = [
    new z.core.$ZodCheckMinLength({ check: 'min_length', minimum: min, when: onArray }),
  ];
  if (max !== undefined) {
    checks.push(
      new z.core.$ZodCheckMaxLength({ check: 'max_length', maximum: max, when: onArray }),
    );
  }
  return z.array(item).check(...checks);
}
