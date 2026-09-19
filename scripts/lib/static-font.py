"""Instantiate every variable axis before native/web font conversion."""
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

font = TTFont(sys.argv[1], recalcTimestamp=False)
if "fvar" in font:
    axes = {axis.axisTag: axis.defaultValue for axis in font["fvar"].axes}
    axes["wght"] = int(sys.argv[3])
    font = instantiateVariableFont(font, axes, inplace=True)
font.save(sys.argv[2])
