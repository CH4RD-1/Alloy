// Small pure helpers for the Knowledge base view.
//
// The prototype's Knowledge base used a full contenteditable rich-text
// editor (Title/Subtitle/Normal blocks, plus inline images inserted as
// data-URIs) — DocPanel now ports that directly (see applyFormat/insertImage
// there), writing h2/h4/p/img markup straight into the same `body_html`
// column an earlier, plain-textarea pass of this port used to write plain
// <p> paragraphs into. stripHtml below is the only piece still needed here:
// it strips whatever tags now show up (headings and images included) down
// to plain text for card/portal previews.

// Strips tags and unescapes the handful of entities article HTML can
// contain — used for card/portal previews, not a general HTML sanitizer.
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
