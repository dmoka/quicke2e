"""Model-free tests for the local engine's prompt and readout logic.  python -m unittest local-engine/test_server.py"""
import json, os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server as S  # the MLX / llama.cpp backends load lazily, so no model is needed here


class Prompt(unittest.TestCase):
    def test_labels_are_A_to_Z_then_AA(self):
        self.assertEqual(S.LABELS[:3], ["A", "B", "C"])
        self.assertEqual(S.LABELS[25:28], ["Z", "AA", "AB"])
        self.assertGreaterEqual(len(S.LABELS), 100)

    def test_evidence_is_compact_and_keeps_only_page_facts(self):
        ev = S.evidence({"url": "/checkout", "title": "Pay", "values": {"Email": "a@b.c"}, "done": ["typed Email"],
                         "elements": [{"i": "4", "r": "textbox", "l": "Email", "v": "a@b.c"},
                                      {"i": "5", "r": "option", "l": "Growth", "p": 1}], "secret": "x"})
        self.assertEqual(ev["elements"], ["4 textbox Email = a@b.c", "5 option Growth (popup)"])
        self.assertNotIn("secret", ev)

    def test_messages_have_the_trained_shape(self):
        msgs = S.messages({"url": "/"}, "Sign in", ["CLICK:1: CLICK 1 Sign in [button]"], ["A"])
        self.assertEqual(msgs[0]["role"], "system")
        body = json.loads(msgs[1]["content"])
        self.assertEqual(set(body), {"evidence", "criterion", "options"})
        self.assertEqual(body["options"][0], {"letter": "A", "description": "CLICK:1: CLICK 1 Sign in [button]"})

    def test_option_texts_fall_back_for_meta_options(self):
        self.assertEqual(S.option_texts({"WAIT": "", "CLICK:1": "CLICK 1 Go [link]"}),
                         [("WAIT", "WAIT: wait for the page"), ("CLICK:1", "CLICK:1: CLICK 1 Go [link]")])


class Distribution(unittest.TestCase):
    def reader(self, winner, calls):
        def read(batch):
            calls.append(len(batch))
            w = [5.0 if t == winner else 0.0 for t in batch]
            return S.softmax(w)
        return read

    def test_one_pass_when_it_fits(self):
        calls = []
        texts = [f"o{i}" for i in range(20)]
        p = S.distribution(self.reader("o7", calls), texts, 26)
        self.assertEqual(calls, [20])
        self.assertEqual(max(range(20), key=lambda i: p[i]), 7)

    def test_groups_then_final_when_it_does_not_fit(self):
        calls = []
        texts = [f"o{i}" for i in range(60)]
        p = S.distribution(self.reader("o57", calls), texts, 26)
        self.assertTrue(all(c <= 26 for c in calls))
        self.assertEqual(len(calls), 4)                 # 3 groups of 20 + one final
        self.assertEqual(calls[-1], 26)                 # the final is filled up to 26
        self.assertEqual(max(range(60), key=lambda i: p[i]), 57)
        self.assertAlmostEqual(sum(p), 1.0, places=6)


if __name__ == "__main__":
    unittest.main()
