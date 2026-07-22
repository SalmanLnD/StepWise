export const EXAMPLES = {
  python: [
    {
      id: 'py-bubble',
      title: 'Bubble Sort',
      topic: 'Sorting',
      code: `# Bubble sort — watch elements swap into place
nums = [7, 3, 9, 1, 5, 2]
n = len(nums)

for i in range(n - 1):
    for j in range(n - 1 - i):
        if nums[j] > nums[j + 1]:
            nums[j], nums[j + 1] = nums[j + 1], nums[j]

print("sorted:", nums)
`,
    },
    {
      id: 'py-binary-search',
      title: 'Binary Search',
      topic: 'Searching',
      code: `# Binary search — watch lo, mid, hi close in
nums = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91]
target = 23

lo = 0
hi = len(nums) - 1
found = -1

while lo <= hi:
    mid = (lo + hi) // 2
    if nums[mid] == target:
        found = mid
        break
    elif nums[mid] < target:
        lo = mid + 1
    else:
        hi = mid - 1

print("found at index", found)
`,
    },
    {
      id: 'py-fib',
      title: 'Fibonacci (recursion)',
      topic: 'Recursion',
      code: `# Recursion — watch the call stack grow and shrink
def fib(n):
    if n <= 1:
        return n
    a = fib(n - 1)
    b = fib(n - 2)
    return a + b

result = fib(5)
print("fib(5) =", result)
`,
    },
    {
      id: 'py-linkedlist',
      title: 'Linked List Reversal',
      topic: 'Linked Lists',
      code: `# Reverse a linked list — watch the arrows flip
class Node:
    def __init__(self, val):
        self.val = val
        self.next = None

head = Node(1)
head.next = Node(2)
head.next.next = Node(3)
head.next.next.next = Node(4)

prev = None
cur = head
while cur is not None:
    nxt = cur.next
    cur.next = prev
    prev = cur
    cur = nxt

head = prev
cur = head
while cur is not None:
    print(cur.val)
    cur = cur.next
`,
    },
    {
      id: 'py-bst',
      title: 'BST Insert',
      topic: 'Trees',
      code: `# Build a binary search tree node by node
class Node:
    def __init__(self, val):
        self.val = val
        self.left = None
        self.right = None

def insert(root, val):
    if root is None:
        return Node(val)
    if val < root.val:
        root.left = insert(root.left, val)
    else:
        root.right = insert(root.right, val)
    return root

root = None
for v in [8, 3, 10, 1, 6, 14, 4]:
    root = insert(root, v)

def inorder(node):
    if node is None:
        return
    inorder(node.left)
    print(node.val)
    inorder(node.right)

inorder(root)
`,
    },
    {
      id: 'py-bfs',
      title: 'Graph BFS',
      topic: 'Graphs',
      code: `# Breadth-first search — watch nodes light up
graph = {
    "A": ["B", "C"],
    "B": ["D", "E"],
    "C": ["F"],
    "D": [],
    "E": ["F"],
    "F": [],
}

visited = []
queue = ["A"]

while len(queue) > 0:
    node = queue.pop(0)
    if node in visited:
        continue
    visited.append(node)
    for nb in graph[node]:
        if nb not in visited:
            queue.append(nb)

print("order:", visited)
`,
    },
    {
      id: 'py-twopointers',
      title: 'Two Pointers',
      topic: 'Two Pointers',
      code: `# Two-sum on a sorted array with two pointers
nums = [1, 3, 4, 6, 8, 11, 13]
target = 14

left = 0
right = len(nums) - 1

while left < right:
    s = nums[left] + nums[right]
    if s == target:
        print("pair:", nums[left], "+", nums[right])
        break
    elif s < target:
        left += 1
    else:
        right -= 1
`,
    },
    {
      id: 'py-hashmap',
      title: 'HashMap Frequency',
      topic: 'HashMap',
      code: `# Count character frequency in a dict
text = "visualize"
freq = {}

for ch in text:
    if ch in freq:
        freq[ch] += 1
    else:
        freq[ch] = 1

for ch, count in freq.items():
    print(ch, "->", count)
`,
    },
    {
      id: 'py-dp',
      title: 'DP: Climbing Stairs',
      topic: 'DP',
      code: `# Dynamic programming — watch the table fill up
n = 8
dp = [0] * (n + 1)
dp[0] = 1
dp[1] = 1

for i in range(2, n + 1):
    dp[i] = dp[i - 1] + dp[i - 2]

print("ways to climb", n, "stairs:", dp[n])
`,
    },
  ],
  c: [
    {
      id: 'c-bubble',
      title: 'Bubble Sort',
      topic: 'Sorting',
      code: `#include <stdio.h>

int main() {
    int arr[6] = {7, 3, 9, 1, 5, 2};
    int n = 6;

    for (int i = 0; i < n - 1; i++) {
        for (int j = 0; j < n - 1 - i; j++) {
            if (arr[j] > arr[j + 1]) {
                int tmp = arr[j];
                arr[j] = arr[j + 1];
                arr[j + 1] = tmp;
            }
        }
    }

    for (int i = 0; i < n; i++) {
        printf("%d ", arr[i]);
    }
    printf("\\n");
    return 0;
}
`,
    },
    {
      id: 'c-pointers',
      title: 'Pointers & Swap',
      topic: 'Pointers',
      code: `#include <stdio.h>

void swap(int *a, int *b) {
    int tmp = *a;
    *a = *b;
    *b = tmp;
}

int main() {
    int x = 10;
    int y = 20;
    printf("before: x=%d y=%d\\n", x, y);
    swap(&x, &y);
    printf("after:  x=%d y=%d\\n", x, y);
    return 0;
}
`,
    },
    {
      id: 'c-linkedlist',
      title: 'Linked List (malloc)',
      topic: 'Linked Lists',
      code: `#include <stdio.h>
#include <stdlib.h>

struct Node {
    int val;
    struct Node *next;
};

int main() {
    struct Node *head = NULL;

    for (int i = 3; i >= 1; i--) {
        struct Node *node = (struct Node*)malloc(sizeof(struct Node));
        node->val = i * 10;
        node->next = head;
        head = node;
    }

    struct Node *cur = head;
    while (cur != NULL) {
        printf("%d\\n", cur->val);
        cur = cur->next;
    }
    return 0;
}
`,
    },
    {
      id: 'c-recursion',
      title: 'Factorial (recursion)',
      topic: 'Recursion',
      code: `#include <stdio.h>

int fact(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * fact(n - 1);
}

int main() {
    int result = fact(5);
    printf("5! = %d\\n", result);
    return 0;
}
`,
    },
    {
      id: 'c-binsearch',
      title: 'Binary Search',
      topic: 'Searching',
      code: `#include <stdio.h>

int main() {
    int arr[8] = {2, 5, 8, 12, 16, 23, 38, 56};
    int target = 16;
    int lo = 0;
    int hi = 7;
    int found = -1;

    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if (arr[mid] == target) {
            found = mid;
            break;
        } else if (arr[mid] < target) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    printf("found at %d\\n", found);
    return 0;
}
`,
    },
  ],
  cpp: [
    {
      id: 'cpp-vector',
      title: 'Vector Selection Sort',
      topic: 'Sorting',
      code: `#include <iostream>
#include <vector>
using namespace std;

int main() {
    vector<int> v = {6, 2, 9, 4, 1};

    for (int i = 0; i < (int)v.size() - 1; i++) {
        int minIdx = i;
        for (int j = i + 1; j < (int)v.size(); j++) {
            if (v[j] < v[minIdx]) {
                minIdx = j;
            }
        }
        int tmp = v[i];
        v[i] = v[minIdx];
        v[minIdx] = tmp;
    }

    for (int x : v) {
        cout << x << " ";
    }
    cout << endl;
    return 0;
}
`,
    },
    {
      id: 'cpp-stack',
      title: 'Stack: Balanced Brackets',
      topic: 'Stacks',
      code: `#include <iostream>
#include <stack>
#include <string>
using namespace std;

int main() {
    string s = "({[]})";
    stack<char> st;
    bool ok = true;

    for (int i = 0; i < (int)s.length(); i++) {
        char c = s.at(i);
        if (c == '(' || c == '{' || c == '[') {
            st.push(c);
        } else {
            if (st.empty()) { ok = false; break; }
            char top = st.top();
            st.pop();
            if (c == ')' && top != '(') ok = false;
            if (c == '}' && top != '{') ok = false;
            if (c == ']' && top != '[') ok = false;
        }
    }
    if (!st.empty()) ok = false;
    cout << (ok ? "balanced" : "not balanced") << endl;
    return 0;
}
`,
    },
    {
      id: 'cpp-node',
      title: 'Linked List (new)',
      topic: 'Linked Lists',
      code: `#include <iostream>
using namespace std;

struct Node {
    int val;
    Node* next;
    Node(int v) : val(v), next(nullptr) {}
};

int main() {
    Node* head = new Node(1);
    head->next = new Node(2);
    head->next->next = new Node(3);

    Node* cur = head;
    while (cur != nullptr) {
        cout << cur->val << endl;
        cur = cur->next;
    }
    return 0;
}
`,
    },
    {
      id: 'cpp-map',
      title: 'Map Word Count',
      topic: 'HashMap',
      code: `#include <iostream>
#include <map>
#include <string>
using namespace std;

int main() {
    string words[5] = {"go", "rust", "go", "cpp", "go"};
    map<string, int> freq;

    for (int i = 0; i < 5; i++) {
        freq[words[i]]++;
    }

    cout << "go appears " << freq["go"] << " times" << endl;
    cout << "distinct words: " << freq.size() << endl;
    return 0;
}
`,
    },
    {
      id: 'cpp-fib',
      title: 'Fibonacci (recursion)',
      topic: 'Recursion',
      code: `#include <iostream>
using namespace std;

int fib(int n) {
    if (n <= 1) {
        return n;
    }
    return fib(n - 1) + fib(n - 2);
}

int main() {
    int result = fib(6);
    cout << "fib(6) = " << result << endl;
    return 0;
}
`,
    },
  ],
  java: [
    {
      id: 'java-insertion',
      title: 'Insertion Sort',
      topic: 'Sorting',
      code: `public class Main {
    public static void main(String[] args) {
        int[] arr = {9, 4, 7, 1, 6};

        for (int i = 1; i < arr.length; i++) {
            int key = arr[i];
            int j = i - 1;
            while (j >= 0 && arr[j] > key) {
                arr[j + 1] = arr[j];
                j--;
            }
            arr[j + 1] = key;
        }

        for (int x : arr) {
            System.out.print(x + " ");
        }
        System.out.println();
    }
}
`,
    },
    {
      id: 'java-recursion',
      title: 'Sum Digits (recursion)',
      topic: 'Recursion',
      code: `public class Main {
    static int sumDigits(int n) {
        if (n == 0) {
            return 0;
        }
        return n % 10 + sumDigits(n / 10);
    }

    public static void main(String[] args) {
        int result = sumDigits(4721);
        System.out.println("sum = " + result);
    }
}
`,
    },
    {
      id: 'java-node',
      title: 'Linked List',
      topic: 'Linked Lists',
      code: `public class Main {
    static class Node {
        int val;
        Node next;
        Node(int v) {
            val = v;
        }
    }

    public static void main(String[] args) {
        Node head = new Node(10);
        head.next = new Node(20);
        head.next.next = new Node(30);

        Node cur = head;
        while (cur != null) {
            System.out.println(cur.val);
            cur = cur.next;
        }
    }
}
`,
    },
    {
      id: 'java-hashmap',
      title: 'HashMap Frequency',
      topic: 'HashMap',
      code: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        String text = "banana";
        HashMap<Character, Integer> freq = new HashMap<>();

        for (char c : text.toCharArray()) {
            freq.put(c, freq.getOrDefault(c, 0) + 1);
        }

        System.out.println(freq);
    }
}
`,
    },
    {
      id: 'java-dp',
      title: 'DP: Coin Change',
      topic: 'DP',
      code: `public class Main {
    public static void main(String[] args) {
        int[] coins = {1, 3, 4};
        int amount = 6;
        int[] dp = new int[amount + 1];

        for (int i = 1; i <= amount; i++) {
            dp[i] = 999;
            for (int c : coins) {
                if (i - c >= 0 && dp[i - c] + 1 < dp[i]) {
                    dp[i] = dp[i - c] + 1;
                }
            }
        }

        System.out.println("min coins for " + amount + ": " + dp[amount]);
    }
}
`,
    },
  ],
};

export const DEFAULT_EXAMPLE = { language: 'python', id: 'py-bubble' };

export function getExample(language, id) {
  return EXAMPLES[language]?.find((e) => e.id === id) ?? EXAMPLES[language]?.[0];
}
