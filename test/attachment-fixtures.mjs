import {zipSync,strToU8} from 'fflate';
export const officeZip=files=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([key,value])=>[key,strToU8(value)]))));
export function documentFixture(){return officeZip({'word/document.xml':'<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>附件测试 &amp; 正文</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>第二行</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'});}
export function spreadsheetFixture(){return officeZip({
  'xl/workbook.xml':'<workbook xmlns:r="relationships"><sheets><sheet name="销售" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml':'<sst><si><t>项目</t></si><si><r><t>合</t></r><r><t>计</t></r></si></sst>',
  'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>收入</t></is></c></row><row><c r="A2" t="s"><v>1</v></c><c r="B2"><f>SUM(B3:B4)</f><v>42</v></c><c r="C2"><f>HYPERLINK("https://example.invalid")</f></c></row></sheetData></worksheet>'
});}
export function pdfFixture(pages=['Quarterly revenue: 42']) {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count '+pages.length+' /Kids ['+pages.map((_,i)=>(4+i*2)+' 0 R').join(' ')+'] >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for(const [i,value] of pages.entries()){const stream='BT /F1 12 Tf 50 750 Td ('+value+') Tj ET';objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents '+(5+i*2)+' 0 R >>','<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream');}
  let output='%PDF-1.7\n',offsets=[0];for(const [i,value]of objects.entries()){offsets.push(Buffer.byteLength(output));output+=(i+1)+' 0 obj\n'+value+'\nendobj\n';}
  const start=Buffer.byteLength(output);output+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF';return Buffer.from(output);
}
