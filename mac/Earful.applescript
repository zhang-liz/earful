-- Earful: a Dock icon for the Earful server.
-- Opening the app starts the server and opens the page. Clicking the Dock
-- icon again reopens the page. Quitting the app stops the server.

on helper()
	return quoted form of POSIX path of (path to resource "earful.sh")
end helper

on run
	-- In the background, so the app does not hang while the server starts.
	do shell script helper() & " start >/dev/null 2>&1 &"
end run

-- earful://wake, from the browser extension: start the server, open no page,
-- since the reader is already on the page they want read.
on open location theURL
	do shell script helper() & " wake >/dev/null 2>&1 &"
end open location

on reopen
	do shell script helper() & " start >/dev/null 2>&1 &"
end reopen

on quit
	do shell script helper() & " stop"
	continue quit
end quit
