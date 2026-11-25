import {useEffect, useRef} from 'react';
import {Diff2HtmlUI} from 'diff2html/lib-esm/ui/js/diff2html-ui-slim.js';
import 'diff2html/bundles/css/diff2html.min.css';
import 'highlight.js/styles/github-dark.min.css';

/** A color-coded unified diff with syntax highlighting. Loaded only when a diff is opened. files shows each file's name. */
export default function DiffView({patch, files = false}: {patch: string; files?: boolean}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const ui = new Diff2HtmlUI(box.current, patch, {
      outputFormat: 'line-by-line',
      drawFileList: false,
      colorScheme: 'dark' as any,
      matching: 'lines',
      diffStyle: 'word',
      highlight: true,
      fileContentToggle: false,
      stickyFileHeaders: false,
      synchronisedScroll: false,
    });
    ui.draw();
    ui.highlightCode();
  }, [patch]);
  return <div className={'diff-view' + (files ? ' with-files' : '')} ref={box} />;
}
