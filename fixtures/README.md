# Test fixtures

`examples/` holds copies of the example models that the tests read. The app
edits `models/` (the Docker container mounts it), so tests must not read from
there: moving or editing an example in the app would break them. Change these
copies only together with the tests that rely on them.
