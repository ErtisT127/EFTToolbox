//go:build windows

package main

import (
	"bytes"
	"image/png"
	"testing"
)

// Both embedded brand images are drawn straight on the desktop: the splash banner sits in a
// transparent frameless window, and the icon is handed to Windows as the window and tray icon. A
// flattened or undersized file shows up as an opaque plate or a scaled smear on the user's screen,
// and a tray icon Windows cannot decode is silently replaced by its own default.
func TestEmbeddedBrandImagesAreTransparentPNGs(t *testing.T) {
	for name, data := range map[string][]byte{"splashBanner": splashBanner, "appIcon": appIcon} {
		image, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		if image.Bounds().Dx() < 256 || image.Bounds().Dy() < 256 {
			t.Fatalf("%s is too small: %v", name, image.Bounds())
		}
		transparent := false
		for y := image.Bounds().Min.Y; y < image.Bounds().Max.Y && !transparent; y++ {
			for x := image.Bounds().Min.X; x < image.Bounds().Max.X; x++ {
				_, _, _, alpha := image.At(x, y).RGBA()
				if alpha < 0xffff {
					transparent = true
					break
				}
			}
		}
		if !transparent {
			t.Fatalf("%s has no transparent pixels", name)
		}
	}
}
