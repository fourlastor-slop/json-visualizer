/** Hands text to the browser as a file to save. */
export function downloadText(fileName: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked later: some browsers start reading the URL only after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A name that is safe to use as a file name on any system. */
export function fileNameFor(title: string, extension: string): string {
  const stem = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${stem || 'untitled'}.${extension}`;
}
