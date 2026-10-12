import type { ChatContext } from './types';
export type ExtractionOrigin = {version:number;format:'pdf'|'docx';original_sha256:string;text_sha256:string;original_bytes:number;parser:string;unit_kind:'page'|'paragraph';total_units:number;units:{number:number;start:number;end:number}[];empty_units:number[];omissions:string[]};
export type SelectedDocument = {name:string;text:string;extraction?:{origin:ExtractionOrigin;expires_at:number;signature:string}};
export const DOCUMENT_BYTES=65536,FILE_BYTES=8*1024*1024;
export const utf8Bytes=(text:string)=>new TextEncoder().encode(text).length;
export const validDocumentName=(name:string)=>typeof name==='string'&&name===name.trim()&&name.length>0&&name.length<=120&&!/^\.(txt|md|pdf|docx)$/i.test(name)&&/\.(txt|md|pdf|docx)$/i.test(name)&&!/[\p{C}\\/:\[\]]/u.test(name);
export function validateDocuments(documents:SelectedDocument[],now=Date.now()) {
  if(!documents.length||documents.length>4||new Set(documents.map(d=>d.name.toLowerCase())).size!==documents.length)throw new Error('Choose up to four files with different names.');
  let total=0;
  for(const d of documents){if(!validDocumentName(d.name)||typeof d.text!=='string'||!d.text.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(d.text))throw new Error('Choose a named, nonempty UTF-8 document.');total+=utf8Bytes(d.text);
    if(/\.(pdf|docx)$/i.test(d.name)){const proof=d.extraction,o=proof?.origin;
      if(!proof||!Number.isInteger(proof.expires_at)||proof.expires_at*1000<=now||!/^[a-f0-9]{64}$/.test(proof.signature)||!o||o.version!==1||!d.name.toLowerCase().endsWith('.'+o.format)||o.unit_kind!==(o.format==='pdf'?'page':'paragraph')||![o.original_sha256,o.text_sha256].every(v=>/^[a-f0-9]{64}$/.test(v))||!Number.isInteger(o.original_bytes)||o.original_bytes<1||o.original_bytes>FILE_BYTES||!Number.isInteger(o.total_units)||o.total_units<1||o.total_units>(o.format==='pdf'?100:500)||!Array.isArray(o.units)||!o.units.length||o.units.length>500||!Array.isArray(o.empty_units)||o.empty_units.length>500||!Array.isArray(o.omissions)||o.omissions.length>6||o.omissions.some(v=>typeof v!=='string'||v.length>300))throw new Error('The extracted document is invalid or expired. Choose the original file again.');
      let end=0,number=0;const seen=new Set<number>();for(const u of o.units){if(!Number.isInteger(u.number)||u.number<=number||u.number>o.total_units||u.start!==end+1||!Number.isInteger(u.end)||u.end<u.start)throw new Error('Extracted locations are inconsistent.');end=u.end;number=u.number;seen.add(number);}for(const n of o.empty_units){if(!Number.isInteger(n)||n<1||n>o.total_units||seen.has(n))throw new Error('Extracted locations are inconsistent.');seen.add(n);}if(end!==d.text.split('\n').length||seen.size!==o.total_units)throw new Error('Extracted locations are inconsistent.');
    }else if(d.extraction)throw new Error('Text documents cannot claim PDF/Word extraction.');
  }
  if(total>DOCUMENT_BYTES)throw new Error('Selected text must total 64 KiB or less.');
}
export function validateDocumentContext(context:ChatContext,message:string){if(!context.documents?.length)return;validateDocuments(context.documents);if(context.photo||context.screenshot||context.note_refs?.length||context.case_ref||context.target_id||context.diagnostic_id||context.lan_inference||/\[vault:/i.test(message))throw new Error('Ask about documents on their own using Local / current setup. Remove the other context or the documents.');}
