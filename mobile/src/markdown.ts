export type Block = { kind: 'paragraph' | 'heading' | 'quote' | 'list'; text: string; level?: number } | { kind: 'code'; text: string; language: string } | { kind: 'table'; rows: string[][] };
export type Inline = { text: string; kind: 'text' | 'code' | 'strong' | 'em' | 'link'; url?: string };
export function safeURL(value: string): string | undefined {
  if (/[\u0000-\u0020\u007f]/.test(value) || !/^https?:\/\//i.test(value)) return;
  try { const u = new URL(value); if (u.username || u.password) return; return u.href; } catch { return; }
}
export function inline(text: string): Inline[] {
  const out: Inline[] = []; let last = 0;
  for (const m of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
    if (m.index! > last) out.push({kind:'text',text:text.slice(last,m.index)});
    if (m[1]) out.push({kind:'code',text:m[1]});
    else if (m[2]) out.push({kind:'strong',text:m[2]});
    else if (m[3]) out.push({kind:'em',text:m[3]});
    else { const source = /^(?:[NRODC]\d+|[^\]]+\.(?:txt|md|pdf|docx):L\d+(?:-L?\d+)?)$/i.test(m[4]!); const url = !source && safeURL(m[5]!); out.push(url ? {kind:'link',text:m[4]!,url} : {kind:'text',text:source ? `[${m[4]}]` : m[0]}); }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({kind:'text',text:text.slice(last)});
  return out;
}
const cells = (s: string) => s.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(x=>x.trim().replace(/\\\|/g,'|'));
const separator = (s: string) => s.includes('|') && cells(s).length > 1 && cells(s).every(x=>/^:?-{3,}:?$/.test(x));
export function blocks(raw: string): Block[] {
  const lines = raw.replace(/\r\n?/g,'\n').split('\n'), out: Block[] = []; let i=0;
  while(i<lines.length) {
    const line=lines[i++]!; if(!line.trim()) continue;
    const fence=line.match(/^\s*```([\w+-]*)\s*$/);
    if(fence) {const text:string[]=[];while(i<lines.length&&!/^\s*```\s*$/.test(lines[i]!))text.push(lines[i++]!);if(i<lines.length)i++;out.push({kind:'code',language:fence[1]||'Code',text:text.join('\n')});continue;}
    if(i<lines.length&&separator(lines[i]!)) {const rows=[cells(line)];i++;while(i<lines.length&&lines[i]!.includes('|')&&lines[i]!.trim())rows.push(cells(lines[i++]!));out.push({kind:'table',rows});continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/); if(heading){out.push({kind:'heading',level:heading[1]!.length,text:heading[2]!});continue;}
    if(/^\s*>/.test(line)){out.push({kind:'quote',text:line.replace(/^\s*>\s?/,'')});continue;}
    if(/^\s*(?:[-*•]|\d+[.)])\s/.test(line)){out.push({kind:'list',text:line.replace(/^\s*[-*•]\s/,'• ')});continue;}
    out.push({kind:'paragraph',text:line});
  }
  return out;
}
