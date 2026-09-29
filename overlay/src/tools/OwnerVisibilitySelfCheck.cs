using EFTToolbox.Contracts;

namespace EFTToolbox.Overlay;

/// <summary>
/// Exercises the shared owner-visibility rule. The cases mirror the node test in
/// dashboard/test/map-tests.mjs one for one, so the overlay's mirror of the dashboard rule cannot
/// drift unnoticed. Run with --owner-visibility-self-check.
/// </summary>
internal static class OwnerVisibilitySelfCheck
{
    internal static Task Run()
    {
        var self = "self";
        var teammate = "mate";
        var departed = "gone";
        var status = new MultiplayerStatus { Members = [new MultiplayerMember { PeerId = teammate }] };

        Check("own markers render while a room is active", new OwnerVisibility(self, [teammate], [], []), self, true);
        Check("own markers render outside a room", new OwnerVisibility(self, [], [], []), self, true);
        Check("own markers hide when hidden explicitly", new OwnerVisibility(self, [], [self], []), self, false);
        Check("manual hide beats the roster", new OwnerVisibility(self, [teammate], [teammate], []), teammate, false);
        Check("room members default visible", new OwnerVisibility(self, [teammate], [], []), teammate, true);
        Check("departed owners default hidden", new OwnerVisibility(self, [teammate], [], []), departed, false);
        Check("explicitly shown departed owners render", new OwnerVisibility(self, [teammate], [], [departed]), departed, true);
        Check("hidden beats an explicit show", new OwnerVisibility(self, [teammate], [departed], [departed]), departed, false);
        Check("an unknown owner stays hidden", new OwnerVisibility(self, [teammate], [], []), "stranger", false);
        Check("no identity means nothing is filtered", OwnerVisibility.ShowAll, "stranger", true);
        Check("the snapshot builds the rule from roster and owner lists", OwnerVisibility.From(self, status, new MarkerPreferences
        {
            HiddenOwners = [departed],
            ShownOwners = ["old"],
        }), teammate, true);
        Check("the snapshot keeps an explicitly shown departed owner", OwnerVisibility.From(self, status, new MarkerPreferences
        {
            HiddenOwners = [],
            ShownOwners = [departed],
        }), departed, true);

        Console.WriteLine("Owner visibility self-check passed: shared rule matches the dashboard/cast matrix.");
        return Task.CompletedTask;
    }

    private static void Check(string name, OwnerVisibility rule, string ownerId, bool expected)
    {
        if (rule.Allows(ownerId) == expected) return;
        throw new InvalidOperationException($"owner visibility: {name} expected {(expected ? "visible" : "hidden")}");
    }
}
