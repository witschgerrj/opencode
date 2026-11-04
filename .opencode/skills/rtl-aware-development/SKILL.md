---
name: rtl-aware-development
description: Build test review RTL LTR direction behavior desktop web CSS menus scrolling
  resize titlebars.
---

# RTL-Aware Development

Direction != language. Test English both directions, real RTL, mixed scripts.

## Guidelines

- Set `lang` and `dir` on document. Propagate direction via component providers for portaled menus, popovers. Never change selected locale just to force RTL.
- Keep DOM and focus order semantic. Flexbox/Grid follow `dir` natively; do NOT add `row-reverse`, CSS `order`, or reversed markup to mirror layout.
- Prefer logical CSS for semantic layout. Reserve physical coords for pointer positions, canvas geometry, native window controls, physical placement.

```css
/* Avoid */
padding-left: 12px;
right: 0;
border-right: 1px solid;
text-align: left;

/* Prefer */
padding-inline-start: 12px;
inset-inline-end: 0;
border-inline-end: 1px solid;
text-align: start;
```

- Isolate mixed-direction text. Use `dir="auto"` or `<bdi>` for unknown text; keep code, URLs, IDs, FS paths LTR without forcing parent component LTR.

```html
<span class="file-row"><bdi dir="auto">README.md</bdi></span> <bdi dir="ltr"><code>C:\src\app.ts</code></bdi>
```

- Mirror directional meaning, not every asset. Back/forward, prev/next, disclosure, indent, directional progress → mirror. Do NOT mirror brands, clocks, media controls, charts, text. Explicitly reverse physical gradients, `translateX`, SVG transforms, animation deltas.
- Map interactions via direction. `clientX` stays physical; resizing logical edge requires RTL-aware delta. Logical prev/next keys may swap ArrowLeft/ArrowRight. Follow WAI-ARIA widget spec.
- Never assume LTR scrolling. RTL `scrollLeft` can init at `0` → negative values. Prefer `scrollIntoView({ inline: "nearest" })` or tested direction-normalizing helper.
- Electron title bars: prefer native caption controls, use `titleBarOverlay` + `env(titlebar-area-*)` for safe content rect. Keep Windows/macOS native-control avoidance and `trafficLightPosition` physical; app nav inside safe rect stays logical. Mark interactive titlebar children `app-region: no-drag`.
- Verify behavior, not screenshots alone. Check computed styles, pseudo-element geometry, hit zones, focus order, keyboard nav, submenu direction, zoom/scaling, LTR/RTL scroll endpoints.

## Test Matrix

- English + LTR
- English + forced RTL
- Real RTL locale + RTL
- Mixed RTL/LTR content, long labels, numbers, code, FS paths
- Keyboard, pointer resize, scrolling, menus/submenus, Electron titlebar controls in both directions

## References

- [RTL Styling 101, Ahmad Shadeed](https://rtlstyling.com/posts/rtl-styling/)
- [CSS-Tricks: RTL Styling 101](https://css-tricks.com/rtl-styling-101/)
- [CSS-Tricks: CSS Logical Properties and Values](https://css-tricks.com/css-logical-properties-and-values/)
- [W3C: Structural markup and right-to-left text](https://www.w3.org/International/questions/qa-html-dir)
- [W3C: Inline bidirectional markup](https://www.w3.org/International/articles/inline-bidi-markup/)
- [MDN: CSS logical properties and values](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Logical_properties_and_values)
- [MDN: `dir`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/dir)
- [MDN: `scrollLeft`](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollLeft)
- [web.dev: Logical properties](https://web.dev/learn/css/logical-properties/)
- [Electron: Custom title bar](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- [WAI-ARIA: Window splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)
- [Kobalte: I18n Provider](https://kobalte.dev/docs/core/components/i18n-provider/)
