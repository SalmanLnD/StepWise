/**
 * Realistic student / interview programs — not just curated examples.
 * Run: node scripts/user-code.js
 */
import { trace } from '../src/trace.js';

const cases = [];
const add = (name, language, code, stdin, check) => cases.push({ name, language, code, stdin: stdin ?? '', check });

/* ============================ Python ============================ */

add(
  'py-insertion-sort-input-map-splat',
  'python',
  `n = int(input())
arr = list(map(int, input().split()))
for i in range(1, n):
    key = arr[i]
    j = i - 1
    while j >= 0 and arr[j] > key:
        arr[j + 1] = arr[j]
        j -= 1
    arr[j + 1] = key
print(*arr)
`,
  '5\n3 1 4 1 5',
  (r) => r.ok && r.stdout.trim().endsWith('1 1 3 4 5')
);

add(
  'py-lambda-filter-any',
  'python',
  `nums = [1, 2, 3, 4, 5]
evens = list(filter(lambda x: x % 2 == 0, nums))
print(any(x > 3 for x in nums), all(x > 0 for x in nums), *evens)
`,
  '',
  (r) => r.ok && r.stdout.includes('True True 2 4')
);

add(
  'py-try-except-assert',
  'python',
  `try:
    x = int("nope")
except ValueError as e:
    x = -1
assert x == -1
print("ok", x)
`,
  '',
  (r) => r.ok && r.stdout.includes('ok -1')
);

add(
  'py-fstring-walrus-starred',
  'python',
  `vals = [10, 20, 30, 40]
a, *mid, b = vals
if (n := len(mid)) > 0:
    print(f"a={a:>3} mid={n} b={b:.1f}")
`,
  '',
  (r) => r.ok && /a=\s*10 mid=2 b=40/.test(r.stdout)
);

add(
  'py-dict-comp-collections',
  'python',
  `from collections import Counter, deque
s = "banana"
c = Counter(s)
d = {k: v for k, v in c.items() if v > 1}
q = deque([1, 2])
q.appendleft(0)
print(sorted(d.items()), q.popleft(), list(q))
`,
  '',
  (r) => r.ok && r.stdout.includes("'a'") && r.stdout.includes('3') && r.stdout.includes('0')
);

add(
  'py-math-random-seeded',
  'python',
  `import math, random
random.seed(1)
print(int(math.sqrt(16)), random.randint(1, 1))
`,
  '',
  (r) => r.ok && r.stdout.includes('4 1')
);

add(
  'py-generator-yield',
  'python',
  `def gen(n):
    for i in range(n):
        yield i * i
print(*gen(4))
`,
  '',
  (r) => r.ok && r.stdout.includes('0 1 4 9')
);

add(
  'py-defaults-kwargs-splat-call',
  'python',
  `def add(a, b=1, *rest, **kw):
    return a + b + sum(rest) + sum(kw.values())
print(add(2), add(2, 3, 4, 5, x=6))
`,
  '',
  (r) => r.ok && r.stdout.includes('3') && r.stdout.includes('20')
);

add(
  'py-stdin-exhausted-message',
  'python',
  `print(input())
print(input())
`,
  'only-one-line',
  (r) => !r.ok && r.error?.kind === 'InputError' && /Input panel/i.test(r.error.message)
);

/* ============================ C ============================ */

add(
  'c-switch-do-while',
  'c',
  `#include <stdio.h>
int main() {
  int x = 2, i = 0, s = 0;
  switch (x) {
    case 1: s = 10; break;
    case 2: s = 20; break;
    default: s = 0;
  }
  do { i++; } while (i < 3);
  printf("%d %d\\n", s, i);
  return 0;
}
`,
  '',
  (r) => r.ok && r.stdout.includes('20 3')
);

add(
  'c-string-qsort-2d',
  'c',
  `#include <stdio.h>
#include <string.h>
#include <stdlib.h>
int main() {
  char a[20] = "hi";
  char b[20] = "there";
  strcat(a, b);
  int arr[5] = {5, 1, 4, 2, 3};
  qsort(arr, 5, sizeof(int), 0);
  int m[2][2] = {{1, 2}, {3, 4}};
  printf("%d %d %d %d\\n", (int)strlen(a), arr[0], arr[4], m[1][0]);
  return 0;
}
`,
  '',
  (r) => r.ok && r.stdout.includes('7 1 5 3')
);

add(
  'c-scanf-atoi',
  'c',
  `#include <stdio.h>
#include <stdlib.h>
int main() {
  int n;
  char buf[32];
  scanf("%d %s", &n, buf);
  printf("%d\\n", n + atoi(buf));
  return 0;
}
`,
  '5 10',
  (r) => r.ok && r.stdout.includes('15')
);

/* ============================ C++ ============================ */

add(
  'cpp-vector-sort-begin-end',
  'cpp',
  `#include <bits/stdc++.h>
using namespace std;
int main() {
  vector<int> v = {5, 1, 4, 2, 3};
  sort(v.begin(), v.end());
  reverse(v.begin(), v.end());
  for (int x : v) cout << x << " ";
  cout << endl;
  return 0;
}
`,
  '',
  (r) => r.ok && r.stdout.includes('5 4 3 2 1')
);

add(
  'cpp-queue-map-set-pair',
  'cpp',
  `#include <bits/stdc++.h>
using namespace std;
int main() {
  queue<int> q;
  q.push(1); q.push(2);
  map<string, int> m;
  m["a"] = 3;
  set<int> s;
  s.insert(9); s.insert(1);
  pair<int,int> p;
  p.first = 7; p.second = 8;
  cout << q.front() << " " << m["a"] << " " << s.count(1) << " " << p.first << endl;
  return 0;
}
`,
  '',
  (r) => r.ok && r.stdout.includes('1 3 1 7')
);

add(
  'cpp-getline-cin',
  'cpp',
  `#include <bits/stdc++.h>
using namespace std;
int main() {
  int n;
  string line;
  cin >> n;
  getline(cin, line);
  getline(cin, line);
  cout << n << ":" << line << endl;
  return 0;
}
`,
  '3\nhello world',
  (r) => r.ok && r.stdout.includes('3:hello world')
);

add(
  'cpp-string-methods',
  'cpp',
  `#include <bits/stdc++.h>
using namespace std;
int main() {
  string s = "abc";
  s.push_back('!');
  cout << s.substr(1, 2) << " " << s.find('b') << " " << s.size() << endl;
  return 0;
}
`,
  '',
  (r) => r.ok && r.stdout.includes('bc 1 4')
);

/* ============================ Java ============================ */

add(
  'java-scanner-arrays-sort',
  'java',
  `import java.util.*;
public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    int n = sc.nextInt();
    int[] a = new int[n];
    for (int i = 0; i < n; i++) a[i] = sc.nextInt();
    Arrays.sort(a);
    System.out.println(Arrays.toString(a));
  }
}
`,
  '4\n4 1 3 2',
  (r) => r.ok && r.stdout.includes('[1, 2, 3, 4]')
);

add(
  'java-collections-string-format',
  'java',
  `import java.util.*;
public class Main {
  public static void main(String[] args) {
    ArrayList<Integer> list = new ArrayList<>();
    list.add(3); list.add(1); list.add(2);
    Collections.sort(list);
    Collections.reverse(list);
    System.out.println(String.format("top=%d size=%d", list.get(0), list.size()));
  }
}
`,
  '',
  (r) => r.ok && r.stdout.includes('top=3 size=3')
);

add(
  'java-hashmap-character',
  'java',
  `import java.util.*;
public class Main {
  public static void main(String[] args) {
    String s = "Ab1";
    HashMap<Character, Integer> m = new HashMap<>();
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (Character.isLetter(c)) m.put(c, m.getOrDefault(c, 0) + 1);
    }
    System.out.println(m.size() + " " + Character.toLowerCase(s.charAt(0)));
  }
}
`,
  '',
  (r) => r.ok && (r.stdout.includes('2 a') || r.stdout.includes("2 'a'"))
);

/* ============================ runner ============================ */

let failed = 0;
for (const c of cases) {
  try {
    const r = await trace(c.language, c.code, c.stdin);
    const ok = c.check(r);
    if (ok) {
      console.log(`PASS ${c.name} (${r.stepCount} steps)`);
    } else {
      failed++;
      console.log(`FAIL ${c.name}`);
      console.log('  error:', r.error);
      console.log('  stdout:', JSON.stringify(r.stdout));
      console.log('  steps:', r.stepCount);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name} — threw ${e.message}`);
    console.error(e);
  }
}
console.log(failed ? `SUMMARY: ${failed}/${cases.length} FAILED` : `SUMMARY: ALL PASS (${cases.length})`);
process.exitCode = failed ? 1 : 0;
