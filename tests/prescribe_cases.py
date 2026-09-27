# Each case: exercise, and the last session's sets as (w, reps, rir).
# Chosen to hit every branch of the rule, including the ones my JS got wrong.
CASES = [
  ("bench_press",   []),                                        # no baseline
  ("bench_press",   [(60,8,1),(60,7,1),(60,7,2)]),              # hold
  ("bench_press",   [(60,10,1),(60,10,2),(60,10,0)]),           # progress
  ("bench_press",   [(60,10,1),(60,10,None)]),                  # blank RIR -> hold, not progress
  ("bench_press",   [(60,5,0),(60,8,2)]),                       # deload (below floor at RIR 0)
  ("bench_press",   [(60,8,1),(62.5,6,1)]),                     # mid-session change -> LAST set's load
  ("bench_press",   [(63,4,0)]),                                # deload rounding to 2.5
  ("pullup",        [(0,9,1),(0,8,1)]),                          # bodyweight hold
  ("pullup",        [(0,10,1),(0,10,2)]),                        # bodyweight progress -> first increment
  ("pullup",        [(0,3,0),(0,5,0)]),                          # bodyweight deload floor
  ("lateral_raise", [(10,15,2),(10,15,1)]),                      # progress at a 15 ceiling
  ("lat_pulldown_machine", [(50,9,3)]),                          # RIR 3 -> hold, above rir_ceiling
]
