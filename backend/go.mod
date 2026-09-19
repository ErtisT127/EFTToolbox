module efttoolbox/backend

go 1.25.0

require (
	efttoolbox/contracts v0.0.0
	github.com/Microsoft/go-winio v0.6.2
	github.com/coder/websocket v1.8.14
)

require golang.org/x/sys v0.10.0 // indirect

replace efttoolbox/contracts => ../contracts/go
