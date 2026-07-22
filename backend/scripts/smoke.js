import { trace } from '../src/trace.js';

const CASES = [
  {
    name: 'py-basics',
    language: 'python',
    code: `
def fib(n):
    if n <= 1:
        return n
    return fib(n - 1) + fib(n - 2)

nums = [3, 1, 2]
nums.sort()
nums.append(fib(6))
d = {"a": 1}
d["b"] = len(nums)
total = sum(nums)
print("nums:", nums, "total:", total)
for i, x in enumerate(nums):
    print(f"{i} -> {x}")
sq = [x * x for x in range(5) if x % 2 == 0]
print(sq)
`,
    expect: 'nums: [1, 2, 3, 8] total: 14\n0 -> 1\n1 -> 2\n2 -> 3\n3 -> 8\n[0, 4, 16]\n',
  },
  {
    name: 'py-class-linkedlist',
    language: 'python',
    code: `
class Node:
    def __init__(self, val):
        self.val = val
        self.next = None

head = Node(1)
head.next = Node(2)
head.next.next = Node(3)

cur = head
while cur is not None:
    print(cur.val)
    cur = cur.next
`,
    expect: '1\n2\n3\n',
  },
  {
    name: 'py-error',
    language: 'python',
    code: `x = [1]\nprint(x[5])\n`,
    expectError: /out of range/,
  },
  {
    name: 'c-basics',
    language: 'c',
    code: `
#include <stdio.h>

int square(int x) {
    return x * x;
}

int main() {
    int arr[5] = {5, 2, 8, 1, 9};
    int n = 5;
    for (int i = 0; i < n - 1; i++) {
        for (int j = 0; j < n - 1 - i; j++) {
            if (arr[j] > arr[j + 1]) {
                int tmp = arr[j];
                arr[j] = arr[j + 1];
                arr[j + 1] = tmp;
            }
        }
    }
    for (int i = 0; i < n; i++) printf("%d ", arr[i]);
    printf("\\n%d\\n", square(6));
    double avg = 7.5;
    printf("%.2f\\n", avg);
    return 0;
}
`,
    expect: '1 2 5 8 9 \n36\n7.50\n',
  },
  {
    name: 'c-pointers-malloc',
    language: 'c',
    code: `
#include <stdio.h>
#include <stdlib.h>

struct Node {
    int val;
    struct Node *next;
};

int main() {
    struct Node *head = (struct Node*)malloc(sizeof(struct Node));
    head->val = 1;
    head->next = (struct Node*)malloc(sizeof(struct Node));
    head->next->val = 2;
    head->next->next = NULL;

    struct Node *cur = head;
    while (cur != NULL) {
        printf("%d\\n", cur->val);
        cur = cur->next;
    }

    int x = 10;
    int *p = &x;
    *p = 42;
    printf("x=%d\\n", x);

    int *nums = malloc(3 * sizeof(int));
    nums[0] = 7; nums[1] = 8; nums[2] = 9;
    printf("%d %d %d\\n", nums[0], nums[1], nums[2]);
    free(nums);
    return 0;
}
`,
    expect: '1\n2\nx=42\n7 8 9\n',
  },
  {
    name: 'c-strings',
    language: 'c',
    code: `
#include <stdio.h>
#include <string.h>

int main() {
    char buf[20] = "hello";
    strcat(buf, " world");
    printf("%s (%d)\\n", buf, (int)strlen(buf));
    char c = 'A';
    c = c + 1;
    printf("%c\\n", c);
    return 0;
}
`,
    expect: 'hello world (11)\nB\n',
  },
  {
    name: 'cpp-vector-stack',
    language: 'cpp',
    code: `
#include <iostream>
#include <vector>
#include <stack>
using namespace std;

int main() {
    vector<int> v = {4, 1, 3};
    v.push_back(9);
    int total = 0;
    for (int x : v) total += x;
    cout << "total=" << total << endl;

    stack<int> st;
    st.push(1);
    st.push(2);
    cout << st.top() << " " << st.size() << endl;
    st.pop();
    cout << st.top() << endl;

    string s = "abc";
    s += "def";
    cout << s.substr(1, 3) << " " << s.length() << endl;
    return 0;
}
`,
    expect: 'total=17\n2 2\n1\nbcd 6\n',
  },
  {
    name: 'cpp-class-newnode',
    language: 'cpp',
    code: `
#include <iostream>
using namespace std;

struct Node {
    int val;
    Node* next;
    Node(int v) : val(v), next(nullptr) {}
};

int main() {
    Node* head = new Node(10);
    head->next = new Node(20);
    Node* cur = head;
    while (cur != nullptr) {
        cout << cur->val << endl;
        cur = cur->next;
    }
    int fact = 1;
    for (int i = 2; i <= 5; i++) fact *= i;
    cout << "5! = " << fact << endl;
    return 0;
}
`,
    expect: '10\n20\n5! = 120\n',
  },
  {
    name: 'cpp-map-cin',
    language: 'cpp',
    code: `
#include <iostream>
#include <map>
using namespace std;

int main() {
    int a, b;
    cin >> a >> b;
    cout << a + b << endl;
    map<string, int> freq;
    freq["x"]++;
    freq["x"]++;
    freq["y"] = 5;
    cout << freq["x"] << " " << freq["y"] << " " << freq.size() << endl;
    return 0;
}
`,
    stdin: '3 4',
    expect: '7\n2 5 2\n',
  },
  {
    name: 'java-basics',
    language: 'java',
    code: `
import java.util.*;

public class Main {
    static int fib(int n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
    }

    public static void main(String[] args) {
        int[] arr = {5, 2, 8, 1};
        int max = Integer.MIN_VALUE;
        for (int x : arr) {
            max = Math.max(max, x);
        }
        System.out.println("max=" + max);
        System.out.println("fib(7)=" + fib(7));

        ArrayList<Integer> list = new ArrayList<>();
        list.add(10);
        list.add(20);
        list.set(0, 99);
        System.out.println(list + " size=" + list.size());

        HashMap<String, Integer> map = new HashMap<>();
        map.put("a", 1);
        map.put("a", map.get("a") + 1);
        System.out.println(map.get("a") + " " + map.containsKey("b"));

        String s = "hello";
        System.out.println(s.toUpperCase() + s.length());
    }
}
`,
    expect: 'max=8\nfib(7)=13\n[99, 20] size=2\n2 false\nHELLO5\n',
  },
  {
    name: 'java-class-node',
    language: 'java',
    code: `
public class Main {
    static class Node {
        int val;
        Node next;
        Node(int v) {
            val = v;
        }
    }

    public static void main(String[] args) {
        Node head = new Node(1);
        head.next = new Node(2);
        Node cur = head;
        while (cur != null) {
            System.out.println(cur.val);
            cur = cur.next;
        }
    }
}
`,
    expect: '1\n2\n',
  },
];

let failed = 0;
for (const c of CASES) {
  const r = await trace(c.language, c.code, c.stdin ?? '');
  const okOut = c.expect === undefined || r.stdout === c.expect;
  const okErr = c.expectError === undefined ? r.ok : !r.ok && c.expectError.test(r.error.message);
  if (okOut && okErr) {
    console.log(`PASS ${c.name} (${r.stepCount} steps)`);
  } else {
    failed++;
    console.log(`FAIL ${c.name}`);
    console.log('  stdout:', JSON.stringify(r.stdout));
    if (c.expect !== undefined) console.log('  expect:', JSON.stringify(c.expect));
    if (r.error) console.log('  error:', r.error);
  }
}
console.log(failed ? `SUMMARY: ${failed} FAILED` : 'SUMMARY: ALL PASS');
process.exitCode = failed ? 1 : 0;
