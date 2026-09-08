"""Render the verified offline MCP transcript. Requires Pillow >=10."""
import json
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
data=json.loads(Path('docs/workflow-demo.json').read_text(encoding='utf-8'))
font_paths=['C:/Windows/Fonts/consola.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']
font_path=next((p for p in font_paths if Path(p).exists()),None)
def font(size):return ImageFont.truetype(font_path,size) if font_path else ImageFont.load_default(size=size)
frames=[]
for index,step in enumerate(data['frames']):
 image=Image.new('RGB',(1120,630),'#0b111a');draw=ImageDraw.Draw(image)
 draw.rounded_rectangle((30,30,1090,600),radius=18,fill='#111c2a',outline='#263a51',width=2)
 draw.text((64,58),f"substack-mcp {data['version']}  /  {index+1} of {len(data['frames'])}",font=font(23),fill='#79b5ff')
 draw.text((64,103),step['title'],font=font(34),fill='#f4f7fb')
 draw.line((64,160,1050,160),fill='#304861',width=2)
 command=step['command']
 # Wrap only display text; input/outputs in the JSON transcript remain intact.
 import textwrap
 lines=textwrap.wrap(command,74,break_long_words=False)
 y=190
 for line in lines:draw.text((64,y),line,font=font(21),fill='#8dd5b1');y+=30
 y=max(y+32,292)
 for line in step['lines']:
  for wrapped in textwrap.wrap(line,76,break_long_words=False):draw.text((64,y),wrapped,font=font(21),fill='#d5dfea');y+=34
 draw.text((64,558),'OFFLINE SAMPLE DATA  /  No live API calls',font=font(18),fill='#91a2b7')
 frames.append(image)
frames[0].save('docs/workflow-demo.gif',save_all=True,append_images=frames[1:],duration=[3500]*len(frames),loop=0,optimize=True)
print(f'Rendered {len(frames)} frames; {Path("docs/workflow-demo.gif").stat().st_size} bytes.')
