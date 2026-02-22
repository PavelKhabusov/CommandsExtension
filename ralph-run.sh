#!/bin/bash
# Run Ralph with sound notification on completion
ralph "$@"
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  say "Ralph finished successfully"
else
  say "Ralph stopped with error"
fi

exit $EXIT_CODE
