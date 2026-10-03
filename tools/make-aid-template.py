"""Builds the aid station templates the setup wizard and settings page offer.

    python3 tools/make-aid-template.py

Writes templates/sendoff-aid-stations.xlsx and .csv. The .xlsx is put
together by hand from its XML parts so nothing needs installing; it has the
stations on the first sheet, which is the one SendOff reads, and the
instructions on a second.
"""
import csv, io, os, zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'templates')

HEAD = ['Aid station', 'Distance (mi)', 'Cutoff (day and time)', 'Crew can meet',
        'Drop bag', 'Pacer pickup', 'Checkpoint only', 'Crew note']
ROWS = [
    ['Start',            0,    '',   'yes', 'no',  'no',  'no',  'Park in the main lot'],
    ['Ridge Road',       6.2,  '',   'yes', 'no',  'no',  'no',  'Pull-off on the left, 4 cars'],
    ['Summit Timing',    11.4, '',   'no',  'no',  'no',  'yes', ''],
    ['Lakeside',         17.9, 'Sat 12:30 PM',  'yes', 'yes', 'yes', 'no',  'Walk in 0.3 mi from the boat ramp'],
    ['Pine Hollow',      24.6, 'Sat 3:00 PM',  'yes', 'no',  'no',  'no',  ''],
    ['Finish',           31.1, 'Sat 5:00 PM',  'yes', 'no',  'no',  'no',  ''],
]
HOWTO = [
    ['How to fill in the aid stations sheet'],
    [''],
    ['One row per stop, in course order, from the start to the finish.'],
    ['Aid station: the name your crew will see. Required.'],
    ['Distance: how far from the start, not from the last stop. The first row is 0. Required.'],
    ['   Head the column "Distance (km)" instead if your distances are in kilometres.'],
    ['Cutoff: the day and time the race publishes, like Sun 1:00 PM, in the race\'s time zone.'],
    ['   With no day, like 6:00 AM, it is the first 6:00 AM after the cutoff above it.'],
    ['   A number on its own, like 30, is hours from the start. Leave empty if there is none.'],
    ['Crew can meet, Drop bag, Pacer pickup, Checkpoint only: yes or no. Empty means no,'],
    ['   except Crew can meet, where empty means yes.'],
    ['Checkpoint only: a timing point with no aid, where the racer is logged but nobody meets them.'],
    ['Crew note: parking, walk-in, anything the crew needs to know getting there.'],
    [''],
    ['Only the first sheet is read. Columns can be in any order, and extra columns are ignored.'],
    ['Delete the example rows and put in your own, then import the file in SendOff.'],
]

def col(i):
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s

def cell(ref, v, style=0):
    st = f' s="{style}"' if style else ''
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return f'<c r="{ref}"{st}><v>{v}</v></c>'
    if v == '':
        return ''
    return f'<c r="{ref}" t="inlineStr"{st}><is><t xml:space="preserve">{escape(str(v))}</t></is></c>'

def sheet(rows, widths, header_style=True, freeze=True):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">']
    if freeze:
        out.append('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>')
    out.append('<cols>' + ''.join(f'<col min="{i+1}" max="{i+1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths)) + '</cols>')
    out.append('<sheetData>')
    for r, row in enumerate(rows):
        style = 1 if (header_style and r == 0) else 0
        cells = ''.join(cell(f'{col(c)}{r+1}', v, style) for c, v in enumerate(row))
        out.append(f'<row r="{r+1}">{cells}</row>')
    out.append('</sheetData></worksheet>')
    return ''.join(out)

FILES = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Aid stations" sheetId="1" r:id="rId1"/><sheet name="How to fill this in" sheetId="2" r:id="rId2"/></sheets>'
        '</workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '</Relationships>',
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF0D1117"/><bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        '</styleSheet>',
    'xl/worksheets/sheet1.xml': sheet([HEAD] + ROWS, [20, 14, 22, 14, 10, 13, 16, 36]),
    'xl/worksheets/sheet2.xml': sheet(HOWTO, [100], header_style=True, freeze=False),
}

os.makedirs(OUT, exist_ok=True)
with zipfile.ZipFile(os.path.join(OUT, 'sendoff-aid-stations.xlsx'), 'w', zipfile.ZIP_DEFLATED) as z:
    for name, body in FILES.items():
        info = zipfile.ZipInfo(name, date_time=(2026, 10, 2, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, body)
buf = io.StringIO()
w = csv.writer(buf, lineterminator='\r\n')
w.writerow(HEAD)
for r in ROWS: w.writerow(['' if v == '' else v for v in r])
with open(os.path.join(OUT, 'sendoff-aid-stations.csv'), 'w', encoding='utf-8-sig', newline='') as f:
    f.write(buf.getvalue())
print('wrote templates/sendoff-aid-stations.xlsx and .csv')
