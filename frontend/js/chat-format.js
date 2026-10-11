/* Small escaped Markdown renderer shared by streamed and retained AI answers. */
(function (root) {
  'use strict';
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function safeLink(value) {
    if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
    if (/^(?:\/(?!\/)|#)/.test(value)) return value;
    if (!/^(?:https?:|mailto:)/i.test(value)) return null;
    try { const u = new URL(value); return ['http:','https:','mailto:'].includes(u.protocol) ? value : null; } catch { return null; }
  }
  function inline(text, depth = 0) {
    if (depth > 3) return esc(text);
    const tokens = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
    let html = '', last = 0;
    for (const m of text.matchAll(tokens)) {
      html += esc(text.slice(last,m.index)); last = m.index + m[0].length;
      if (m[1] != null) html += '<code>' + esc(m[1]) + '</code>';
      else if (m[2] != null) {
        // A model-written source label never authorizes its destination, even
        // while streaming. Checked source controls are built from server receipts.
        const citation = /^(?:[NRDO]\d{1,5}|[^\]\n]{1,120}\.(?:txt|md):L\d{1,6}(?:-L?\d{1,6})?)$/i.test(m[2]);
        const url = citation ? null : safeLink(m[3]); html += citation ? esc('[' + m[2] + ']') : url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inline(m[2],depth+1)}</a>` : esc(m[0]);
      }
      else if (m[4] != null) html += '<strong>' + inline(m[4],depth+1) + '</strong>';
      else html += '<em>' + inline(m[5],depth+1) + '</em>';
    }
    return html + esc(text.slice(last));
  }
  const cells = line => line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(c=>c.trim().replace(/\\\|/g,'|'));
  const separator = line => line.includes('|') && cells(line).length > 1 && cells(line).every(c=>/^:?-{3,}:?$/.test(c));
  function render(raw) {
    const lines = String(raw ?? '').replace(/\r\n?/g,'\n').split('\n'); const blocks=[];
    let i=0;
    const special = index => /^\s*(?:```|#{1,6}\s|[-*•]\s|\d+[.)]\s|>\s?|[-*_]{3,}\s*$)/.test(lines[index] || '') || (index+1<lines.length && separator(lines[index+1]));
    while(i<lines.length) {
      const line=lines[i];
      if(!line.trim()){i++;continue;}
      const fence=line.match(/^\s*```([\w+-]*)\s*$/);
      if(fence) {
        const content=[];i++;while(i<lines.length&&!/^\s*```\s*$/.test(lines[i])) content.push(lines[i++]);if(i<lines.length)i++;
        blocks.push(`<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">${esc(fence[1].toUpperCase()||'CODE')}</span><button type="button" class="code-block-copy" onclick="tliCopyCode(this)" aria-label="Copy code">Copy</button></div><code class="code-block-code">${esc(content.join('\n'))}</code></div>`);continue;
      }
      if(i+1<lines.length&&separator(lines[i+1])) {
        const head=cells(line); i+=2; const rows=[];
        while(i<lines.length&&lines[i].trim()&&lines[i].includes('|')) {const row=cells(lines[i++]);rows.push('<tr>'+head.map((_,j)=>'<td>'+inline(row[j]||'')+'</td>').join('')+'</tr>');}
        blocks.push('<div class="ui-chat-table" tabindex="0" role="region" aria-label="Answer table"><table><thead><tr>'+head.map(h=>'<th scope="col">'+inline(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>');continue;
      }
      const heading=line.match(/^(#{1,6})\s+(.+)$/);
      if(heading) {const level=heading[1].length;blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);i++;continue;}
      if(/^\s*[-*_]{3,}\s*$/.test(line)){blocks.push('<hr>');i++;continue;}
      if(/^\s*>/.test(line)){const items=[];while(i<lines.length&&/^\s*>/.test(lines[i]))items.push(inline(lines[i++].replace(/^\s*>\s?/,'')));blocks.push('<blockquote>'+items.join('<br>')+'</blockquote>');continue;}
      const ordered=/^\s*\d+[.)]\s+/.test(line), unordered=/^\s*[-*•]\s+/.test(line);
      if(ordered||unordered) {const re=ordered?/^\s*\d+[.)]\s+/:/^\s*[-*•]\s+/;const items=[];while(i<lines.length&&re.test(lines[i]))items.push('<li>'+inline(lines[i++].replace(re,''))+'</li>');const tag=ordered?'ol':'ul';blocks.push(`<${tag}>${items.join('')}</${tag}>`);continue;}
      const text=[line];i++;while(i<lines.length&&lines[i].trim()&&!special(i))text.push(lines[i++]);blocks.push('<p>'+text.map(t=>inline(t)).join('<br>')+'</p>');
    }
    return blocks.join('\n');
  }
  const api={render,safeLink};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.TLIChatFormat=api;
})(typeof window==='undefined'?null:window);
